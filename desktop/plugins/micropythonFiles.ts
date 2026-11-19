import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MICROPYTHON_FILES_OWNER, explicitMicropythonPort, micropythonChildPath, micropythonDownloadArgs, micropythonEntryName, micropythonListArgs,
  micropythonRemotePath, type MicropythonDownloadChoice, type MicropythonDownloadResult, type MicropythonFileEntry, type MicropythonListing,
} from "../../shared/micropython";
import { withPort } from "../portLease";
import type { ToolService } from "../tools";
import { resolveMicropythonCommand } from "./micropython";

// Read-only device browsing. Two mpremote calls exist here: `fs ls` and `fs cp` from the device to a
// private local temp file. There is deliberately no mkdir/rm/rmdir/touch/upload call in this module.

const LIST_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_CAPTURE = 1024 * 1024;
// Outstanding picker authorizations are held in memory only; a bounded number keeps that set small.
const MAX_AUTHORIZATIONS = 4;

export const cancelled = () => Object.assign(new Error("操作已取消"), { name: "AbortError" });

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A save-dialog file name is only a suggestion: separators and control characters are refused. */
export function micropythonSuggestedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || /[\\/\x00-\x1f]/.test(name)) return "device-file.bin";
  return name.slice(0, 120) || "device-file.bin";
}

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

/** Opens the host save dialog and returns only its new absolute file, or null when the user cancels. */
export type MicropythonPathPick = (suggestedName: string) => Promise<string | null>;

/** What one save dialog authorizes; never exposed to the renderer. */
interface DownloadAuthorization {
  port: string;
  remote: string;
  target: string;
  generation: number;
  workspace: string | null;
}

/**
 * The single owner of the read-only file operations. Only one runs at a time, it holds the shared port
 * lease for its whole duration, and cancel() aborts it.
 *
 * A download target is never supplied by the renderer. choose() opens one save dialog and binds an
 * opaque, single-use token to the exact port, remote file, local target, workspace and generation.
 * A panel unmount, project switch, window close or dispose() bumps the generation, so a dialog reply
 * that arrives afterwards cannot start mpremote or publish a success.
 */
export class MicropythonFilesService {
  private active: AbortController | null = null;
  private running = new Set<Promise<unknown>>();
  private authorizations = new Map<string, DownloadAuthorization>();
  private temporary = new Set<string>();
  private generation = 0;
  private picking = false;
  constructor(
    private tools: ToolService,
    private options: { listTimeoutMs?: number; downloadTimeoutMs?: number; workspaceRoot?: () => string | null } = {},
  ) {}

  private workspaceRoot() { return this.options.workspaceRoot?.() ?? null; }

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

  /**
   * One save dialog at a time. The captured generation and workspace are re-checked after the dialog
   * resolves; a reply for a panel, project or window that is already gone is discarded without a token.
   */
  async choose(portValue: unknown, remoteValue: unknown, suggestedName: unknown, pick: MicropythonPathPick): Promise<MicropythonDownloadChoice> {
    if (this.picking) return { status: "failed", error: "已有保存对话框正在打开，请先完成或取消它" };
    let port: string; let remote: string;
    try {
      port = explicitMicropythonPort(portValue);
      remote = micropythonRemotePath(remoteValue);
    } catch (error) { return { status: "failed", error: errorText(error) }; }
    const generation = this.generation;
    const workspace = this.workspaceRoot();
    this.picking = true;
    let target: string | null;
    try { target = await pick(micropythonSuggestedName(suggestedName)); }
    catch (error) { return { status: "failed", error: "无法打开保存对话框：" + errorText(error) }; }
    finally { this.picking = false; }
    // Both sides of the await: a stale panel/project/window must not receive an authorization.
    if (this.generation !== generation || this.workspaceRoot() !== workspace) return { status: "cancelled", reason: "invalidated" };
    if (!target) return { status: "cancelled", reason: "picker" };
    if (typeof target !== "string" || !path.isAbsolute(target)) return { status: "failed", error: "保存路径无效" };
    const token = randomBytes(32).toString("hex");
    this.authorizations.set(token, { port, remote, target: path.resolve(target), generation, workspace });
    // Bounded: the oldest outstanding authorization is dropped when the cap is reached.
    while (this.authorizations.size > MAX_AUTHORIZATIONS) {
      const oldest = this.authorizations.keys().next().value;
      if (oldest === undefined) break;
      this.authorizations.delete(oldest);
    }
    return { status: "chosen", token };
  }

  /** Downloads with a token from choose(); it is single-use and scoped to the context that issued it. */
  download(tokenValue: unknown): Promise<MicropythonDownloadResult> {
    return this.track(this.downloadInner(tokenValue));
  }

  private async downloadInner(tokenValue: unknown): Promise<MicropythonDownloadResult> {
    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    const authorization = token ? this.authorizations.get(token) : undefined;
    if (!authorization) throw new Error("保存授权无效或已使用，请重新点击下载并选择保存位置");
    // A stale authorization is discarded rather than being allowed to run in the new context.
    if (authorization.generation !== this.generation || authorization.workspace !== this.workspaceRoot()) {
      this.authorizations.delete(token);
      throw new Error("工程或面板已变化，保存授权已失效；请重新点击下载并选择保存位置");
    }
    // Single use: consumed before spawning, so the same token cannot start a second mpremote.
    this.authorizations.delete(token);
    const { port, remote, target } = authorization;
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
        // Handoff check after the child exited and before the user's file is touched: a cancel or a
        // context change that happened while mpremote ran must leave the destination untouched.
        if (controller.signal.aborted || this.generation !== authorization.generation || this.workspaceRoot() !== authorization.workspace) throw cancelled();
        // Delivered by an exclusive copy so an existing local file is never overwritten.
        try { await fs.copyFile(temporary, target, fs.constants.COPYFILE_EXCL); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("目标文件已存在，未覆盖：" + target + "。请选择新的文件名。");
          throw error;
        }
        // The copy is the commit point and cannot be rolled back reliably: report the real outcome
        // instead of letting a late cancel look like a success or like nothing was written.
        if (controller.signal.aborted) throw new Error("已取消，但复制已提交，文件已写入：" + target + "（未回滚）。");
        return { target, size: stat.size };
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

  /**
   * Retires every reply that belongs to the previous panel/project/window and cancels the running
   * operation. The abort settles on the child's exit, which is also when its temp directory is removed.
   */
  async invalidate(): Promise<void> {
    this.generation++;
    this.authorizations.clear();
    this.cancel();
  }

  /** Kills any in-flight mpremote process and removes every temp directory this service created. */
  async dispose() {
    await this.invalidate();
    // Wait for a killed transfer to release its files before the temp directories are removed.
    await Promise.allSettled([...this.running]);
    for (const directory of [...this.temporary]) {
      this.temporary.delete(directory);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    this.authorizations.clear();
  }
}
