import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MICROPYTHON_FILES_OWNER, micropythonChildPath, micropythonDownloadArgs, micropythonEntryName, micropythonListArgs, micropythonRemotePath,
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
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));
  // A trailing newline is normal; any other empty line means the output is not a clean listing.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) throw new Error("mpremote 没有返回目录头，已停止（不会把空输出当空目录）");
  // mpremote is verbose by default and prints exactly one `ls :<path>` header before the entries.
  const expected = "ls :" + remotePath;
  if (lines[0] !== expected) throw new Error("mpremote 未返回预期的目录头 " + JSON.stringify(expected) + "：" + JSON.stringify(lines[0]) + "，已停止（不会显示其他目录的内容）");
  const entries: MicropythonFileEntry[] = [];
  for (const line of lines.slice(1)) {
    if (!line) throw new Error("mpremote 输出包含空行，无法可靠解析目录内容");
    if (line.startsWith("ls :")) throw new Error("mpremote 输出了多个目录头：" + JSON.stringify(line) + "，已停止");
    if (line.length < 14) throw new Error("无法解析 mpremote fs ls 的输出：" + JSON.stringify(line));
    const sizeField = line.slice(0, 12);
    if (!/^\s*\d+$/.test(sizeField) || line[12] !== " ") throw new Error("无法解析 mpremote fs ls 的输出：" + JSON.stringify(line));
    const rest = line.slice(13);
    const directory = rest.endsWith("/");
    const name = micropythonEntryName(directory ? rest.slice(0, -1) : rest);
    entries.push({ name, path: micropythonChildPath(remotePath, name), type: directory ? "directory" : "file", size: Number(sizeField) });
  }
  return { port: port.trim(), path: remotePath, entries };
}

interface CommandResult { code: number; stdout: string; stderr: string }

/**
 * Spawns mpremote with literal argv (no shell). A cancel or timeout only records the reason and sends
 * the kill signal: the promise settles on the child's `close`, so the port lease is released and the
 * temp file is removed only after the process is actually gone. The SIGKILL upgrade timer is cleared
 * on close as well, so no late kill can reach a recycled pid.
 */
function run(executable: string, argv: string[], signal: AbortSignal, timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const child = spawn(executable, argv, {
      shell: false, windowsHide: true, detached: process.platform !== "win32",
      // Python writes UTF-8 to a pipe here, so Chinese file names survive the trip from the device.
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = ""; let stderr = ""; let settled = false;
    let stopError: Error | null = null;
    let upgrade: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      else { try { process.kill(-child.pid, sig); } catch { /* already gone */ } }
    };
    const settle = (error: Error | null, result?: CommandResult) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(upgrade);
      signal.removeEventListener("abort", aborted);
      if (stopError) reject(stopError); else if (error) reject(error); else resolve(result!);
    };
    // Record the reason and ask the tree to exit; settlement waits for `close`.
    const stop = (reason: Error) => {
      if (settled || stopError) return;
      stopError = reason;
      kill("SIGTERM");
      upgrade = setTimeout(() => kill("SIGKILL"), 1200);
      upgrade.unref?.();
    };
    const aborted = () => stop(cancelled());
    const timer = setTimeout(() => {
      stop(new Error("mpremote 命令超时（" + Math.round(timeoutMs / 1000) + " 秒）：" + argv.join(" ") + "。设备可能没有响应，可重试或先断开串口监视器。"));
    }, timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    // String decoding keeps a multi-byte Chinese character split across chunks intact.
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    const collect = (target: "stdout" | "stderr") => (text: string) => {
      if (settled) return;
      if (target === "stdout") stdout += text; else stderr += text;
      if (stdout.length + stderr.length > MAX_CAPTURE) stop(new Error("mpremote 输出超过上限（" + MAX_CAPTURE + " 字符），已停止；不会把截断的内容当目录列表"));
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));
    child.on("error", (error) => settle(error));
    child.on("close", (code) => settle(null, { code: code ?? -1, stdout, stderr }));
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
  constructor(private tools: ToolService, private options: { listTimeoutMs?: number; downloadTimeoutMs?: number } = {}) {}

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
        const result = await run(command.executable, [...command.prefix, ...args], controller.signal, this.options.listTimeoutMs ?? LIST_TIMEOUT_MS);
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
        const result = await run(command.executable, [...command.prefix, ...micropythonDownloadArgs(port, remote, temporary)], controller.signal, this.options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
        if (result.code !== 0) throw new Error("从设备下载失败（" + remote + "）· " + failureText(result));
        const stat = await fs.stat(temporary).catch(() => null);
        if (!stat?.isFile()) throw new Error("mpremote 报告成功，但没有生成本地文件；未写入目标位置");
        // A cancel that arrives before delivery starts leaves no target at all.
        if (controller.signal.aborted) throw cancelled();
        // Delivered by an exclusive copy so an existing local file is never overwritten.
        try { await fs.copyFile(temporary, resolved, fs.constants.COPYFILE_EXCL); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("目标文件已存在，未覆盖：" + resolved + "。请选择新的文件名。");
          throw error;
        }
        // The issued path is consumed only after a successful delivery, so a failed retry can reuse it.
        this.issued.delete(resolved);
        // The copy is the commit point and cannot be rolled back reliably: report the real outcome
        // instead of letting a late cancel look like a success or like nothing was written.
        if (controller.signal.aborted) throw new Error("已取消，但复制已提交，文件已写入：" + resolved + "（未回滚）。");
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
