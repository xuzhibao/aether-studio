import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolService } from "../tools";

// Every ESP operation (inspection, preflight, backup) runs the same esptool entry point.
// Discovery prefers the PlatformIO installation because that is the exact esptool PlatformIO
// itself uploads with; a user-configured path or AETHER_ESPTOOL always wins.
export type EsptoolSource = "setting" | "environment" | "platformio" | "path";

export interface EsptoolTool {
  /** Executable handed to spawn(); for a script install this is the Python interpreter. */
  executable: string;
  /** Arguments that always precede the esptool command line. */
  prefix: string[];
  /** The esptool entry point as configured/found, for display. */
  script: string;
  version: string;
  source: EsptoolSource;
}

export const ESPTOOL_TOOL: ToolDefinition = {
  id: "esptool", name: "esptool (ESP 芯片工具)", env: "AETHER_ESPTOOL", defaultExecutable: "esptool", versionArgs: ["version"],
  description: "只读检查、部署前核对和分块备份使用的 esptool。默认复用 PlatformIO 自带的 tool-esptoolpy；也可在这里指定 esptool.py 或独立 esptool 可执行文件。",
  // A .py entry point is run by the PlatformIO interpreter, so the status probe reports a real version.
  launch: (path) => (/[.]py$/i.test(path) ? { executable: penvPython(platformioCoreDir()), args: [path] } : null),
};

/** PlatformIO core directory: explicit variable first, then derived from the configured CLI path. */
export function platformioCoreDir(tools?: ToolService): string {
  const configured = process.env.PLATFORMIO_CORE_DIR?.trim();
  if (configured) return configured;
  const cli = tools?.configured("platformio")?.trim();
  if (cli && /[\\/]penv[\\/]/i.test(cli)) {
    // <core>/penv/Scripts/platformio.exe or <core>/penv/bin/platformio
    return path.resolve(path.dirname(cli), "..", "..");
  }
  return path.join(os.homedir(), ".platformio");
}

export function penvPython(core: string): string {
  return process.platform === "win32" ? path.join(core, "penv", "Scripts", "python.exe") : path.join(core, "penv", "bin", "python");
}

const isFile = async (file: string) => !!(await fs.stat(file).catch(() => null))?.isFile();
const isScript = (value: string) => /\.py$/i.test(value);

async function which(command: string): Promise<string | null> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command.toLowerCase().endsWith(extension.toLowerCase()) ? command : command + extension);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function pythonFor(script: string, core: string): Promise<string> {
  // A user-supplied esptool.py still runs on the PlatformIO interpreter when one exists.
  const penv = penvPython(core);
  if (await isFile(penv)) return penv;
  return process.platform === "win32" ? "python" : "python3";
}

async function toolAt(script: string, source: EsptoolSource, core: string): Promise<EsptoolTool | null> {
  if (!script) return null;
  if (isScript(script)) {
    if (!(await isFile(script))) return null;
    return { executable: await pythonFor(script, core), prefix: [script], script, version: "", source };
  }
  if (!(await isFile(script))) return null;
  return { executable: script, prefix: [], script, version: "", source };
}

/**
 * Resolution order: saved tool setting -> AETHER_ESPTOOL -> PlatformIO's bundled tool-esptoolpy
 * -> PATH. Returns null with a readable reason when nothing usable exists.
 */
export async function findEsptool(tools?: ToolService): Promise<{ tool: EsptoolTool | null; reason: string }> {
  const core = platformioCoreDir(tools);
  const setting = tools?.configured("esptool")?.trim() ?? "";
  if (setting) {
    const tool = await toolAt(setting, "setting", core);
    return tool ? { tool, reason: "" } : { tool: null, reason: "工具设置中的 esptool 不可用：" + setting };
  }
  const environment = process.env.AETHER_ESPTOOL?.trim();
  if (environment) {
    const tool = await toolAt(environment, "environment", core);
    return tool ? { tool, reason: "" } : { tool: null, reason: "AETHER_ESPTOOL 指向的文件不可用：" + environment };
  }
  const bundled = path.join(core, "packages", "tool-esptoolpy", "esptool.py");
  const python = penvPython(core);
  if (await isFile(bundled)) {
    if (await isFile(python)) return { tool: { executable: python, prefix: [bundled], script: bundled, version: "", source: "platformio" }, reason: "" };
    return { tool: null, reason: "找到 PlatformIO 的 tool-esptoolpy，但缺少 Python 解释器：" + python };
  }
  const onPath = (await which("esptool")) ?? (await which("esptool.py"));
  if (onPath) {
    const tool = await toolAt(onPath, "path", core);
    if (tool) return { tool, reason: "" };
  }
  return { tool: null, reason: "未找到 esptool。请在插件设置中指定 esptool.py，或安装 PlatformIO Core（自带 tool-esptoolpy）。" };
}

const versions = new Map<string, string>();
/** Reads `esptool version` once per resolved entry point. */
export async function esptoolVersion(tool: EsptoolTool): Promise<string> {
  const key = tool.executable + "\0" + tool.prefix.join("\0");
  const cached = versions.get(key);
  if (cached !== undefined) return cached;
  try {
    const result = await promisify(execFile)(tool.executable, [...tool.prefix, "version"], { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const version = /v?(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? text.trim().split(/\r?\n/).pop()?.slice(0, 40) ?? "";
    versions.set(key, version);
    return version;
  } catch { versions.set(key, ""); return ""; }
}

/** Runs a sibling script (espefuse.py) from the same tool-esptoolpy package when it exists. */
export async function siblingScript(tool: EsptoolTool, name: string): Promise<{ executable: string; prefix: string[] } | null> {
  if (!tool.script || !isScript(tool.script)) return null;
  const candidate = path.join(path.dirname(tool.script), name);
  if (!(await isFile(candidate))) return null;
  return { executable: tool.executable, prefix: [candidate] };
}

export interface EsptoolRun { code: number | null; stdout: string; stderr: string; output: string; command: string; cancelled: boolean }

/**
 * Runs esptool with `shell: false`; the arguments are data (ports, paths), never shell syntax.
 * Cancellation kills the process tree so the port is released even mid-connect.
 */
export function runEsptool(entry: { executable: string; prefix: string[] }, args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<EsptoolRun> {
  return new Promise((resolve) => {
    const child = spawn(entry.executable, [...entry.prefix, ...args], { shell: false, windowsHide: true, detached: process.platform !== "win32" });
    const command = [entry.executable, ...entry.prefix, ...args].join(" ");
    let stdout = ""; let stderr = ""; let settled = false; let cancelled = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    };
    const finish = (code: number | null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener("abort", aborted);
      resolve({ code, stdout, stderr, output: stdout + stderr, command, cancelled });
    };
    const aborted = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { stop(); stderr += "\n[aether] esptool 超时（" + (options.timeoutMs ?? 0) + "ms）"; finish(null); }, options.timeoutMs ?? 120000);
    if (options.signal?.aborted) { aborted(); return; }
    options.signal?.addEventListener("abort", aborted, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { stderr += String(error); finish(null); });
    child.on("close", (code) => finish(code));
  });
}
