import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition, ToolService } from "../tools";
import { CliEsptool, type EsptoolCommand, type EsptoolRunOptions, type EsptoolRunner } from "../flash";

// Single executable path, like every other desktop tool. The host never assembles a shell command;
// a .py entry is handed to a Python interpreter as one literal argument.
export const esptoolTool: ToolDefinition = {
  id: "esptool",
  name: "esptool",
  env: "AETHER_ESPTOOL",
  defaultExecutable: "esptool.py",
  // The probe runs through the resolved interpreter, so a .py entry point reports a real version.
  versionArgs: ["version"],
  launch: (file) => (/[.]py$/i.test(file) ? { executable: findPythonFor(file), args: [file] } : null),
  description: "ESP 芯片 Flash 分块备份、恢复与安全信息只读检查所用的 esptool 可执行文件（也可填写 esptool.py）。",
};

const pythonNames = process.platform === "win32" ? ["python.exe", "py.exe"] : ["python3", "python"];

function findOnPath(name: string) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const hasExtension = !!path.extname(name);
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    // esptool.py is a script, not a PATHEXT executable: check the exact name first.
    const exact = path.join(directory, name);
    if (existsSync(exact)) return exact;
    if (hasExtension) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

/** PlatformIO core directory: explicit variable first, then derived from the configured CLI path. */
export function platformioCoreDir(tool?: ToolService): string {
  const configured = process.env.PLATFORMIO_CORE_DIR?.trim();
  if (configured) return configured;
  const cli = tool?.configured("platformio")?.trim();
  if (cli && /[\\/]penv[\\/]/i.test(cli)) return path.resolve(path.dirname(cli), "..", "..");
  return path.join(os.homedir(), ".platformio");
}

/** PlatformIO's Python interpreter next to a CLI inside a penv/ directory. */
function pythonForCli(cli: string) {
  if (!/[\\/]penv[\\/]/i.test(cli)) return "";
  const directory = path.dirname(cli);
  const candidate = process.platform === "win32" ? path.join(directory, "python.exe") : path.join(directory, "python3");
  return existsSync(candidate) ? candidate : "";
}

export function findPythonFor(esptoolPath: string) {
  const directory = path.dirname(path.resolve(esptoolPath));
  const bundled = process.platform === "win32"
    ? path.resolve(directory, "..", "..", "penv", "Scripts", "python.exe")
    : path.resolve(directory, "..", "..", "penv", "bin", "python3");
  // A custom PLATFORMIO_CORE_DIR may hold only platforms/packages and no penv. In that order, the
  // PlatformIO installation the user configured, then the default home core, still give a Python
  // that has pyserial; a bare system Python usually does not.
  const candidates = [
    bundled,
    process.env.AETHER_ESPTOOL_PYTHON?.trim() ?? "",
    pythonForCli(process.env.AETHER_PLATFORMIO_CLI?.trim() ?? ""),
    process.platform === "win32"
      ? path.join(os.homedir(), ".platformio", "penv", "Scripts", "python.exe")
      : path.join(os.homedir(), ".platformio", "penv", "bin", "python3"),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  const configured = process.env.AETHER_ESPTOOL_PYTHON?.trim();
  if (configured) return configured;
  for (const name of pythonNames) { const found = findOnPath(name); if (found) return found; }
  return "";
}

export function resolveEsptoolCommand(tool: ToolService): EsptoolCommand {
  const resolved = tool.resolve("esptool");
  let executable = resolved.executable;
  // Nothing configured and nothing on PATH: reuse the esptool PlatformIO already installed.
  if (resolved.source === "path" && !existsSync(executable)) {
    const bundled = path.join(platformioCoreDir(tool), "packages", "tool-esptoolpy", "esptool.py");
    if (existsSync(bundled)) executable = bundled;
  }
  if (/\.py$/i.test(executable)) {
    // A bare name from PATH must become an absolute path before it is handed to a Python interpreter.
    if (!path.isAbsolute(executable)) {
      const found = /[\\/]/.test(executable)
        ? (existsSync(path.resolve(executable)) ? path.resolve(executable) : "")
        : findOnPath(path.basename(executable));
      if (!found) throw new Error("找不到 esptool.py：" + executable + "。请在插件设置中填写完整路径。");
      executable = found;
    }
    const python = findPythonFor(executable);
    if (!python) throw new Error("esptool.py 需要 Python 解释器，但未找到。请安装 Python，或在设置中直接填写 esptool 可执行文件路径。");
    return { executable: python, prefixArgs: [executable] };
  }
  return { executable };
}

/** Resolves the configured tool on every call so a settings change cannot leave a stale executable. */
export class ResolvedEsptool implements EsptoolRunner {
  constructor(private tool: ToolService) {}
  get command() { return resolveEsptoolCommand(this.tool); }
  run(args: string[], options?: EsptoolRunOptions) { return new CliEsptool(this.command).run(args, options); }
}

export function createEsptoolRunner(tool: ToolService) {
  tool.define(esptoolTool);
  return new ResolvedEsptool(tool);
}
