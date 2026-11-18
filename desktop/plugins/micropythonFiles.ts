import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MICROPYTHON_FILES_OWNER, micropythonDownloadArgs, micropythonEntryName, micropythonListArgs, micropythonRemotePath,
  type MicropythonDownloadResult, type MicropythonFileEntry, type MicropythonListing,
} from "../../shared/micropython";
import { withPort } from "../portLease";
import type { ToolService } from "../tools";
import { resolveMicropythonCommand } from "./micropython";

// Read-only device browsing. Two mpremote calls exist here: `fs ls` and `fs cp` from the device to a
// private local temp file. There is deliberately no mkdir/rm/rmdir/touch/upload call in this module.

const LIST_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_CAPTURE = 1024 * 1024;

export const cancelled = () => Object.assign(new Error("操作已取消"), { name: "AbortError" });

/**
 * mpremote 1.29.0 prints one entry as `"{:12} {}{}".format(size, name, "/" if directory)`.
 * The size is right-aligned in 12 columns, exactly one space follows, and the name is printed
 * verbatim (so it may contain spaces, Chinese characters or leading spaces). A directory ends in "/".
 * Anything else is reported instead of being guessed at.
 */
export function parseMicropythonListing(text: string, port: string, remotePath: string): MicropythonListing {
  const entries: MicropythonFileEntry[] = [];
  let header = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    // mpremote is verbose by default: `fs ls :/dir` prints this one header line before the entries.
    if (line.startsWith("ls :")) { header = line; continue; }
    if (header && header !== "ls :" + remotePath) throw new Error("mpremote 报告的目录与请求不一致：" + JSON.stringify(header) + "，已停止（不会显示其他目录的内容）");
    if (line.length < 14) throw new Error("无法解析 mpremote fs ls 的输出：" + JSON.stringify(line));
    const sizeField = line.slice(0, 12);
    if (!/^\s*\d+$/.test(sizeField) || line[12] !== " ") throw new Error("无法解析 mpremote fs ls 的输出：" + JSON.stringify(line));
    const rest = line.slice(13);
    const directory = rest.endsWith("/");
    const name = micropythonEntryName(directory ? rest.slice(0, -1) : rest);
    entries.push({ name, path: (remotePath === "/" ? "/" : remotePath + "/") + name, type: directory ? "directory" : "file", size: Number(sizeField) });
  }
  return { port: port.trim(), path: remotePath, entries };
}

interface CommandResult { code: number; stdout: string; stderr: string }

/** Spawns mpremote with literal argv (no shell), honors cancellation and a hard timeout. */
function run(executable: string, argv: string[], signal: AbortSignal, timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const child = spawn(executable, argv, {
      shell: false, windowsHide: true, detached: process.platform !== "win32",
      // Python writes UTF-8 to a pipe here, so Chinese file names survive the trip from the device.
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = ""; let stderr = ""; let settled = false;
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      else { try { process.kill(-child.pid, sig); } catch { /* already gone */ } }
    };
    const finish = (error: Error | null, result?: CommandResult) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(result!);
    };
    const aborted = () => { kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 1200).unref?.(); finish(cancelled()); };
    const timer = setTimeout(() => {
      kill("SIGKILL");
      finish(new Error("mpremote 命令超时（" + Math.round(timeoutMs / 1000) + " 秒）：" + argv.join(" ") + "。设备可能没有响应，可重试或先断开串口监视器。"));
    }, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-MAX_CAPTURE); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-MAX_CAPTURE); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, { code: code ?? -1, stdout, stderr }));
  });
}

const failureText = (result: CommandResult) => {
  const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).filter(Boolean).slice(-4).join(" ");
  return detail ? "退出码 " + result.code + "：" + detail : "退出码 " + result.code;
};

/**
 * The single owner of the read-only file operations. Only one runs at a time, it holds the shared port
 * lease for its whole duration, and cancel() aborts it. A download target is written only when the
 * host save dialog issued that exact path in this session, and only once.
 */
export class MicropythonFilesService {
  private active: AbortController | null = null;
  private running = new Set<Promise<unknown>>();
  private issued = new Set<string>();
  private temporary = new Set<string>();
  constructor(private tools: ToolService) {}

  /** Records a path returned by the host save dialog; a download may write only one of these. */
  issueTarget(file: string) {
    if (typeof file !== "string" || !file || !path.isAbsolute(file)) throw new Error("保存路径无效");
    this.issued.add(path.resolve(file));
    return file;
  }

  private begin() {
    if (this.active) throw new Error("已有正在读取设备文件的操作，请等待或取消");
    const controller = new AbortController();
    this.active = controller;
    return controller;
  }

  private end(controller: AbortController) { if (this.active === controller) this.active = null; }

  /** Tracks the pending operation so dispose() can wait for its cleanup before removing temp files. */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.running.add(promise);
    void promise.then(() => this.running.delete(promise), () => this.running.delete(promise));
    return promise;
  }

  list(port: string, remotePath: string): Promise<MicropythonListing> {
    return this.track(this.listInner(port, remotePath));
  }

  private async listInner(port: string, remotePath: string): Promise<MicropythonListing> {
    const target = micropythonRemotePath(remotePath);
    const args = micropythonListArgs(port, target);
    const controller = this.begin();
    try {
      return await withPort(port, MICROPYTHON_FILES_OWNER, async () => {
        const command = resolveMicropythonCommand(this.tools);
        const result = await run(command.executable, [...command.prefix, ...args], controller.signal, LIST_TIMEOUT_MS);
        if (result.code !== 0) throw new Error("读取设备目录失败（" + target + "）· " + failureText(result));
        return parseMicropythonListing(result.stdout, port, target);
      });
    } finally { this.end(controller); }
  }

  download(port: string, remotePath: string, target: string): Promise<MicropythonDownloadResult> {
    return this.track(this.downloadInner(port, remotePath, target));
  }

  private async downloadInner(port: string, remotePath: string, target: string): Promise<MicropythonDownloadResult> {
    const remote = micropythonRemotePath(remotePath);
    const resolved = typeof target === "string" ? path.resolve(target) : "";
    if (!resolved || !this.issued.has(resolved)) throw new Error("下载目标必须由保存对话框选择；请重新点击下载");
    const controller = this.begin();
    let directory = "";
    try {
      return await withPort(port, MICROPYTHON_FILES_OWNER, async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-download-"));
        this.temporary.add(directory);
        const temporary = path.join(directory, "download.bin");
        const command = resolveMicropythonCommand(this.tools);
        const result = await run(command.executable, [...command.prefix, ...micropythonDownloadArgs(port, remote, temporary)], controller.signal, DOWNLOAD_TIMEOUT_MS);
        if (result.code !== 0) throw new Error("从设备下载失败（" + remote + "）· " + failureText(result));
        const stat = await fs.stat(temporary).catch(() => null);
        if (!stat?.isFile()) throw new Error("mpremote 报告成功，但没有生成本地文件；未写入目标位置");
        // Delivered by an exclusive copy so an existing local file is never overwritten.
        try { await fs.copyFile(temporary, resolved, fs.constants.COPYFILE_EXCL); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("目标文件已存在，未覆盖：" + resolved + "。请选择新的文件名。");
          throw error;
        }
        // The issued path is consumed only after a successful delivery, so a failed retry can reuse it.
        this.issued.delete(resolved);
        return { target: resolved, size: stat.size };
      });
    } finally {
      this.end(controller);
      const current = directory;
      if (current) { this.temporary.delete(current); await fs.rm(current, { recursive: true, force: true }).catch(() => {}); }
    }
  }

  /** Aborts the in-flight operation; the pending promise rejects with an AbortError. */
  cancel() {
    const active = this.active;
    if (!active) return false;
    active.abort();
    return true;
  }

  /** Kills any in-flight mpremote process and removes every temp directory this service created. */
  async dispose() {
    this.cancel();
    // Wait for a killed transfer to release its files before the temp directories are removed.
    await Promise.allSettled([...this.running]);
    for (const directory of [...this.temporary]) {
      this.temporary.delete(directory);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    this.issued.clear();
  }
}
