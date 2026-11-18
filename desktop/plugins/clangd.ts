import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
const shellScript = /\.(bat|cmd|ps1)$/i;
// --query-driver accepts globs and comma-separated lists; such characters would widen or split the allow-list.
const globCharacters = /[*?[\]]/;
const literalUnsafe = (value: string) => globCharacters.test(value) || value.includes(",");

interface CompilerCache { environment?: unknown; drivers?: unknown }
interface RecordedTask { environment?: string; artifacts?: { path: string; sha256: string }[]; metadata?: CompilerCache }
interface CompileEntry { command?: string; arguments?: string[]; file?: string; directory?: string }

const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const samePath = (left: string, right: string) => fold(path.resolve(left)) === fold(path.resolve(right));

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

async function realDirectory(candidate: string) {
  return fs.realpath(candidate).catch(() => null);
}

// Trusted locations come from the PlatformIO installation itself, never from the candidate path:
// PLATFORMIO_CORE_DIR, the default ~/.platformio, or the core that owns the configured pio executable (<core>/penv/...).
async function packageRoots(executable: string) {
  const roots: string[] = [];
  const configured = process.env.PLATFORMIO_CORE_DIR?.trim();
  if (configured) roots.push(path.resolve(configured));
  roots.push(path.join(os.homedir(), ".platformio"));
  const parts = path.resolve(executable).split(path.sep);
  let penv = -1;
  for (let index = parts.length - 1; index >= 0; index--) if (parts[index].toLowerCase() === "penv") { penv = index; break; }
  if (penv > 0) roots.push(parts.slice(0, penv).join(path.sep) || path.sep);
  const packages: string[] = [];
  for (const root of roots) {
    const real = await realDirectory(root);
    const realPackages = real ? await realDirectory(path.join(real, "packages")) : null;
    if (realPackages && !packages.some((item) => samePath(item, realPackages))) packages.push(realPackages);
  }
  return packages;
}

// Only an existing literal executable inside <core>/packages is ever authorized for query-driver.
async function trustedCompiler(candidate: string, packages: string[]) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || literalUnsafe(candidate) || shellScript.test(candidate)) return null;
  const real = await realDirectory(candidate);
  // Symlinks are resolved before the check: the target path must also be a literal inside the trusted packages.
  if (!real || literalUnsafe(real)) return null;
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) return null;
  const inside = packages.some((root) => fold(real).startsWith(fold(root) + path.sep));
  return inside ? real : null;
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

// Compilers are resolved by the explicit compiledb task (PlatformIO metadata executes project scripts) and cached there.
// Starting the language service only reads that cache; it never runs PlatformIO or project scripts.
async function cachedDrivers(record: RecordedTask, used: string[], executable: string) {
  const cache = record.metadata;
  const unavailable = "没有当前环境的编译器缓存；请重新运行 Generate compilation database（启动语言服务不会执行工程脚本）。";
  if (!cache || !Array.isArray(cache.drivers) || cache.drivers.length === 0) return { drivers: [] as string[], message: unavailable };
  if (typeof cache.environment === "string" && cache.environment && cache.environment !== (record.environment ?? "")) {
    return { drivers: [] as string[], message: "编译器缓存属于环境 " + cache.environment + "，与当前数据库记录不一致；请重新生成。" };
  }
  const packages = await packageRoots(executable);
  const drivers: string[] = [];
  for (const value of cache.drivers) {
    if (typeof value !== "string") continue;
    const trusted = await trustedCompiler(value, packages);
    if (!trusted) continue;
    // The cached compiler must be the one the database actually invokes (exact path, or the bare tool name in its directory).
    const usedByDatabase = used.some((token) => path.isAbsolute(token) ? samePath(token, trusted) : samePath(path.resolve(path.dirname(trusted), token), trusted));
    if (!usedByDatabase) continue;
    if (!drivers.some((item) => samePath(item, trusted))) drivers.push(trusted);
  }
  const message = drivers.length ? "" : "缓存中的编译器不在 PlatformIO 核心 packages 目录内，或未被当前编译数据库使用；未启用 query-driver。";
  return { drivers, message };
}

// Resolves which compilation database, if any, belongs to the selected PlatformIO environment.
export async function compileDatabaseContext(root: string, options: LanguageStartOptions = {}, tool?: ToolService): Promise<LanguageLaunchContext> {
  const empty = path.join(root, EMPTY_DATABASE);
  const requested = options.environment?.trim() ?? "";
  const task = await recorded(root);
  const file = path.join(root, databaseArtifact);
  const environment = requested || task?.environment?.trim() || "";
  const missing = async (state: CompileDatabaseState, message: string): Promise<LanguageLaunchContext> => {
    await fs.mkdir(empty, { recursive: true });
    // An empty but valid database keeps clangd from searching parent directories for another environment's flags.
    if (!(await fs.stat(path.join(empty, databaseArtifact)).catch(() => null))) await fs.writeFile(path.join(empty, databaseArtifact), "[]");
    return { environment, compileDatabase: state, compileDatabaseMessage: message, queryDrivers: [] };
  };
  const digest = await databaseDigest(file);
  if (!task) {
    if (!digest) return missing("missing", "尚未生成编译数据库；语言服务使用 clangd 默认参数，诊断可能不准确。");
    // Ordinary C/C++ and CMake projects may provide a database without any PlatformIO task record.
    if (requested) return missing("stale", "工程根目录有 compile_commands.json，但没有环境 " + requested + " 的生成记录，无法确认数据库所属环境；请重新生成。");
    let compilers: string[];
    try { compilers = await compilersOf(file); } catch (error) { return missing("stale", "compile_commands.json 无法解析，需要重新生成：" + String(error)); }
    const message = "工程根目录有 compile_commands.json，但没有 PlatformIO 任务记录，无法确认所属环境。"
      + (options.queryDriver === true ? " 没有编译器缓存，未启用 query-driver。" : "")
      + (compilers.length ? "" : "编译数据库没有编译单元。");
    return { environment: "", compileDatabase: "ready", compileDatabaseMessage: message, queryDrivers: [] };
  }
  if (requested && task.environment !== requested) {
    return missing("stale", task.environment
      ? "编译数据库属于环境 " + task.environment + "，当前选择 " + requested + "；请为该环境重新生成。"
      : "任务记录没有环境信息（旧版本生成），当前选择 " + requested + "；请重新运行 Generate compilation database。");
  }
  if (!digest) return missing("missing", "任务记录存在，但 compile_commands.json 不在工程根目录；请重新生成。");
  const recordedDigest = task.artifacts?.find((artifact) => artifact.path === databaseArtifact)?.sha256;
  if (recordedDigest && recordedDigest !== digest) return missing("stale", "compile_commands.json 与 .aether/compiledb.json 记录不一致；请重新生成。");

  let compilers: string[];
  try { compilers = await compilersOf(file); } catch (error) { return missing("stale", "compile_commands.json 无法解析，需要重新生成：" + String(error)); }
  let queryDrivers: string[] = [];
  let allowedMessage = "";
  if (options.queryDriver === true) {
    if (!tool) allowedMessage = "缺少 PlatformIO 工具设置，未启用 query-driver。";
    else ({ drivers: queryDrivers, message: allowedMessage } = await cachedDrivers(task, compilers, tool.executable("platformio")));
  }
  return { environment, compileDatabase: "ready", compileDatabaseMessage: allowedMessage, queryDrivers };
}

export function clangdProvider(tool: ToolService): LanguageProvider {
  return {
    id: "clangd", tool: "clangd", executable: () => tool.executable("clangd"),
    context: (root, options) => compileDatabaseContext(root, options, tool),
    env: (context) => {
      // PlatformIO records the compiler by bare name; clangd resolves it through PATH before matching the allow-list.
      if (!context.queryDrivers.length) return process.env;
      const directories = [...new Set(context.queryDrivers.map((driver) => path.dirname(driver)))];
      const current = process.env.PATH ?? process.env.Path ?? "";
      return { ...process.env, PATH: [...directories, current].filter(Boolean).join(path.delimiter) };
    },
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
