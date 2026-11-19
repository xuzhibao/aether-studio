// Shared contract for read-only MicroPython device file browsing and single-file download.
// The host never assembles a shell command: the port and the remote POSIX path are validated here, then
// handed to mpremote as separate argv entries (`connect port:<port> resume fs ls|cp ...`).

import { validProjectPath } from "./projectFormat";

export const MICROPYTHON_RUN_PROVIDER = "micropython.run";
/** Port-lease owner used by the read-only file browser; it shares the lease with runs and ESP checks. */
export const MICROPYTHON_FILES_OWNER = "MicroPython 板载文件";

// An explicit serial path only. `auto` and `list` are mpremote device selectors, not ports, and are
// refused so a renderer cannot ask mpremote to choose or enumerate devices on its own.
const explicitPort = /^[A-Za-z0-9._/\\-]{1,128}$/;
export function explicitMicropythonPort(value: unknown): string {
  const port = typeof value === "string" ? value.trim() : "";
  if (!port) throw new Error("请明确选择端口");
  if (/^(auto|list)$/i.test(port)) throw new Error("端口必须明确指定，不能使用 auto 或 list");
  if (!explicitPort.test(port)) throw new Error("端口格式无效：只接受明确的串口路径（例如 COM3 或 /dev/ttyACM0）");
  return port;
}

export function explicitMicropythonFile(value: unknown): string {
  const file = typeof value === "string" ? value.trim() : "";
  if (!file) throw new Error("请选择工程中已保存的 .py 文件");
  if (!validProjectPath(file)) throw new Error("只能运行工程目录内的相对 .py 文件");
  if (!file.toLowerCase().endsWith(".py")) throw new Error("只能运行 .py 文件");
  return file;
}

/** The exact mpremote argv; the caller passes each entry to spawn without a shell. */
export function micropythonRunArgs(port: string, localFile: string): string[] {
  return ["connect", "port:" + explicitMicropythonPort(port), "run", localFile];
}

/**
 * An absolute POSIX path on the device. Values are never trimmed: leading or trailing spaces can be
 * part of a real device name. Consecutive, `.` and `..` segments are refused rather than normalized,
 * so the host and the device cannot disagree about which directory was listed.
 */
export function micropythonRemotePath(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("请先选择设备上的目录");
  if (value.length > 512) throw new Error("设备路径过长（上限 512 个字符）");
  if (!value.startsWith("/")) throw new Error("设备路径必须是绝对 POSIX 路径，以 / 开头");
  if (/[\x00-\x1f\x7f\\]/.test(value)) throw new Error("设备路径不能包含反斜杠或控制字符");
  if (value === "/") return "/";
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (!segment) throw new Error("设备路径不能包含空片段（不要连续使用 /）");
    if (segment === "." || segment === "..") throw new Error("设备路径不能包含 . 或 .. 片段");
  }
  return "/" + segments.join("/");
}

/** One name as mpremote printed it; it must be a single path segment. */
export function micropythonEntryName(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("设备条目名称无效");
  if (value.length > 128) throw new Error("设备条目名称过长（上限 128 个字符）");
  if (/[/\\\x00-\x1f\x7f]/.test(value)) throw new Error("设备条目名称不能包含 /、反斜杠或控制字符");
  if (value === "." || value === "..") throw new Error("设备条目名称不能是 . 或 ..");
  return value;
}

export function micropythonChildPath(parent: string, name: string): string {
  const base = micropythonRemotePath(parent);
  const entry = micropythonEntryName(name);
  return (base === "/" ? "/" : base + "/") + entry;
}

/** `mpremote connect port:<port> resume fs ls <path>`: resume avoids the automatic soft reset. */
export function micropythonListArgs(port: string, remotePath: string): string[] {
  return ["connect", "port:" + explicitMicropythonPort(port), "resume", "fs", "ls", micropythonRemotePath(remotePath)];
}

/** `mpremote connect port:<port> resume fs cp :<remote> <local>`: the local side is a private temp file. */
export function micropythonDownloadArgs(port: string, remotePath: string, localTarget: string): string[] {
  if (typeof localTarget !== "string" || !localTarget.trim()) throw new Error("缺少本机的下载临时文件");
  return ["connect", "port:" + explicitMicropythonPort(port), "resume", "fs", "cp", ":" + micropythonRemotePath(remotePath), localTarget];
}

export interface MicropythonFileEntry {
  name: string;
  /** Absolute POSIX path for the next `fs ls` or `fs cp`; built from the validated parent and name. */
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface MicropythonListing {
  /** The port this listing was read from; a download uses it instead of the live input field. */
  port: string;
  path: string;
  entries: MicropythonFileEntry[];
}

export interface MicropythonDownloadResult { target: string; size: number }

/**
 * One save-dialog outcome. A chosen dialog issues an opaque, single-use token; the host keeps the port,
 * the remote absolute path and the local destination, so the renderer never selects a local path.
 */
export type MicropythonDownloadChoice =
  | { status: "chosen"; token: string }
  /** `picker`: the user cancelled the dialog. `invalidated`: the panel/project/window changed meanwhile. */
  | { status: "cancelled"; reason: "picker" | "invalidated" }
  | { status: "failed"; error: string };

/** Read-only device file browsing and single-file download. No write, delete, rename or install call exists. */
export interface MicropythonFilesAPI {
  list: (port: string, path: string) => Promise<MicropythonListing>;
  /**
   * Opens the host save dialog for one listed entry. The token it returns is tied to that port, that
   * remote absolute path, the current workspace and picker generation; it is never a local path.
   */
  chooseDownloadPath: (port: string, path: string, suggestedName: string) => Promise<MicropythonDownloadChoice>;
  /** Downloads with a token from chooseDownloadPath; the token can be used once and only in its context. */
  download: (token: string) => Promise<MicropythonDownloadResult>;
  /** Aborts the one in-flight list/download (no effect when idle). */
  cancel: () => Promise<boolean>;
  /** Panel unmount or project change: discard a pending picker reply and cancel the running operation. */
  invalidate: () => Promise<void>;
}
