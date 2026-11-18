// Shared contract for running one saved project script on an already-installed MicroPython board.
// The host never assembles a shell command: the port and file are validated here, then handed to
// mpremote as separate argv entries with `connect port:<port> run <file>`.

import { validProjectPath } from "./projectFormat";

export const MICROPYTHON_RUN_PROVIDER = "micropython.run";

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
