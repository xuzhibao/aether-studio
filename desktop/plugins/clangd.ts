import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LanguageLaunchContext, LanguageProvider } from "../language";
import type { CompileDatabaseState, LanguageStartOptions } from "../../shared/language";
import type { ToolDefinition, ToolService } from "../tools";

// Public tool identity used by the C/C++ plugin UI. The host resolves it from settings → env → PATH.
export const clangdTool: ToolDefinition = {
  id: "clangd", name: "clangd", env: "AETHER_CLANGD_CLI", defaultExecutable: "clangd", versionArgs: ["--version"],
  description: "C/C++ 语言服务可执行文件。",
};

// clangd must not fall back to a compile_commands.json above the source when the recorded database is stale.
const EMPTY_DATABASE = path.join(".aether", "no-compile-database");
const databaseArtifact = "compile_commands.json";

interface RecordedTask { environment?: string; artifacts?: { path: string; sha256: string }[] }
interface CompileEntry { command?: string; arguments?: string[]; file?: string; directory?: string }

const shellScript = /\.(bat|cmd|ps1)$/i;
const absolute = (value: string) => path.isAbsolute(value);

// Windows cmd-style quoting: PlatformIO emits a single command string; the first token is the compiler.
export function firstToken(command: string) {
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"")) {
    const end = trimmed.indexOf("\"", 1);
    return end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0];
}

function coreRoots() {
  const roots: string[] = [];
  const configured = process.env.PLATFORMIO_CORE_DIR?.trim();
  if (configured) roots.push(path.resolve(configured));
  return roots;
}

// A compiler is only allowed when it is an existing executable inside the PlatformIO core packages directory
// (or PLATFORMIO_CORE_DIR); nothing from the compile database is trusted blindly and no wildcard is ever used.
export function platformioCompiler(candidate: string): string | null {
  if (!absolute(candidate) || shellScript.test(candidate) || candidate.includes(",")) return null;
  const resolved = path.resolve(candidate);
  const parts = resolved.split(path.sep);
  const marker = parts.findIndex((part) => part.toLowerCase() === ".platformio");
  const roots = coreRoots();
  if (marker >= 0) roots.push(parts.slice(0, marker + 1).join(path.sep));
  if (!roots.some((root) => resolved === root || resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep))) return null;
  return resolved;
}

async function recorded(root: string): Promise<RecordedTask | null> {
  const text = await fs.readFile(path.join(root, ".aether", "compiledb.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as RecordedTask;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("任务记录不是对象");
    return value;
  } catch (error) { throw new Error("编译数据库任务记录无法解析，需要重新生成：" + String(error)); }
}

async function databaseDigest(file: string) {
  const bytes = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
}

async function compilersOf(file: string) {
  const entries = JSON.parse(await fs.readFile(file, "utf8")) as CompileEntry[];
  if (!Array.isArray(entries)) throw new Error("compile_commands.json 不是数组");
  const result = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("compile_commands.json 条目格式错误");
    const compiler = Array.isArray(entry.arguments) ? entry.arguments[0] : typeof entry.command === "string" ? firstToken(entry.command) : "";
    if (typeof compiler === "string" && compiler) result.add(compiler);
  }
  return [...result];
}

interface Metadata { cc_path?: unknown; cxx_path?: unknown }

// The compilers are resolved by PlatformIO itself for the selected environment (`project metadata`), then only
// accepted when the compile database actually uses them and they live in the PlatformIO core packages directory.
async function environmentCompilers(tool: ToolService, root: string, environment: string, used: string[]) {
  if (!environment) return { drivers: [] as string[], message: "未选择 PlatformIO 环境，无法解析编译器路径。" };
  const executable = tool.executable("platformio");
  let metadata: Record<string, Metadata>;
  try {
    const output = await promisify(execFile)(executable, ["project", "metadata", "--json-output", "-e", environment], { cwd: root, timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    metadata = JSON.parse(output.stdout) as Record<string, Metadata>;
  } catch (error) {
    return { drivers: [] as string[], message: "无法通过 PlatformIO 解析环境 " + environment + " 的编译器，未启用 query-driver：" + String(error) };
  }
  const entry = metadata?.[environment];
  if (!entry || typeof entry !== "object") return { drivers: [] as string[], message: "PlatformIO 未返回环境 " + environment + " 的元数据，未启用 query-driver。" };
  const basenames = new Set(used.map((candidate) => path.basename(candidate).toLowerCase()));
  const drivers: string[] = [];
  for (const value of [entry.cc_path, entry.cxx_path]) {
    if (typeof value !== "string") continue;
    const resolved = platformioCompiler(value);
    if (!resolved || !basenames.has(path.basename(resolved).toLowerCase())) continue;
    if (!(await fs.stat(resolved).catch(() => null))?.isFile()) continue;
    if (!drivers.includes(resolved)) drivers.push(resolved);
  }
  const message = drivers.length ? "" : "所选环境的编译器不在 PlatformIO 核心目录内或未被编译数据库使用，未启用 query-driver。";
  return { drivers, message };
}

// Resolves which compilation database, if any, belongs to the selected PlatformIO environment.
export async function compileDatabaseContext(root: string, options: LanguageStartOptions = {}, tool?: ToolService): Promise<LanguageLaunchContext> {
  const empty = path.join(root, EMPTY_DATABASE);
  const requested = options.environment?.trim() ?? "";
  const task = await recorded(root);
  const environment = requested || task?.environment?.trim() || "";
  const missing = async (state: CompileDatabaseState, message: string): Promise<LanguageLaunchContext> => {
    await fs.mkdir(empty, { recursive: true });
    // An empty but valid database keeps clangd from searching parent directories for another environment's flags.
    if (!(await fs.stat(path.join(empty, databaseArtifact)).catch(() => null))) await fs.writeFile(path.join(empty, databaseArtifact), "[]");
    return { environment, compileDatabase: state, compileDatabaseMessage: message, queryDrivers: [] };
  };
  if (!task) return missing("missing", "尚未生成编译数据库；语言服务使用 clangd 默认参数，诊断可能不准确。");
  if (task.environment && requested && task.environment !== requested) return missing("stale", "编译数据库属于环境 " + task.environment + "，当前选择 " + requested + "；请为该环境重新生成。");
  const file = path.join(root, databaseArtifact);
  const digest = await databaseDigest(file);
  if (!digest) return missing("missing", "任务记录存在，但 compile_commands.json 不在工程根目录；请重新生成。");
  const recordedDigest = task.artifacts?.find((artifact) => artifact.path === databaseArtifact)?.sha256;
  if (recordedDigest && recordedDigest !== digest) return missing("stale", "compile_commands.json 与 .aether/compiledb.json 记录不一致；请重新生成。");

  let compilers: string[] = [];
  try { compilers = await compilersOf(file); } catch (error) { return missing("stale", "compile_commands.json 无法解析，需要重新生成：" + String(error)); }
  let queryDrivers: string[] = [];
  let allowedMessage = "";
  if (options.queryDriver === true) {
    if (!tool) allowedMessage = "缺少 PlatformIO 工具设置，未启用 query-driver。";
    else ({ drivers: queryDrivers, message: allowedMessage } = await environmentCompilers(tool, root, environment, compilers));
  }
  return { environment, compileDatabase: "ready", compileDatabaseMessage: allowedMessage, queryDrivers };
}

export function clangdProvider(tool: ToolService): LanguageProvider {
  return {
    id: "clangd", tool: "clangd", executable: () => tool.executable("clangd"),
    context: (root, options) => compileDatabaseContext(root, options, tool),
    args: (root, context) => {
      const directory = context.compileDatabase === "ready" ? root : path.join(root, EMPTY_DATABASE);
      const args = ["--background-index=false", "--clang-tidy=false", "--enable-config=false", "--log=error", "--compile-commands-dir=" + directory];
      if (context.queryDrivers.length) args.push("--query-driver=" + context.queryDrivers.join(","));
      return args;
    },
  };
}

export function createClangdProvider(tool: ToolService): LanguageProvider {
  tool.define(clangdTool);
  return clangdProvider(tool);
}
