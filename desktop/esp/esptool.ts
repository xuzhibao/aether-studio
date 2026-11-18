import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { esptoolTool, platformioCoreDir, resolveEsptoolCommand } from "../plugins/esptool";
import type { ToolService } from "../tools";

// Discovery is shared with the flash backup/restore service (`desktop/plugins/esptool.ts`): setting →
// AETHER_ESPTOOL → PlatformIO's bundled tool-esptoolpy → PATH. This module only adds the read-only
// command runner used by ESP inspection, the deploy preflight and the verified upload.
export { esptoolTool as ESPTOOL_TOOL, platformioCoreDir };

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

/** Locates esptool through the shared resolver and reports where it came from. */
export async function findEsptool(tools?: ToolService): Promise<{ tool: EsptoolTool | null; reason: string }> {
  if (!tools) return { tool: null, reason: "工具服务不可用" };
  let command: { executable: string; prefixArgs?: string[] };
  try { command = resolveEsptoolCommand(tools); }
  catch (error) { return { tool: null, reason: String(error instanceof Error ? error.message : error) }; }
  const prefix = command.prefixArgs ?? [];
  const script = prefix[0] ?? command.executable;
  const core = platformioCoreDir(tools).replace(/[\\/]+$/, "");
  const configured = tools.configured("esptool").trim();
  const source: EsptoolSource = configured ? "setting" : process.env.AETHER_ESPTOOL?.trim() ? "environment" : script.startsWith(core) ? "platformio" : "path";
  return { tool: { executable: command.executable, prefix, script, version: "", source }, reason: "" };
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
