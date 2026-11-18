import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TaskEnvironment } from "../../shared/desktop";
import type { TaskProvider } from "../tasks";
import type { ToolDefinition, ToolService } from "../tools";

// Public tool identity used by the PlatformIO plugin UI. Users configure this path in the app.
export const platformioTool: ToolDefinition = {
  id: "platformio", name: "PlatformIO Core CLI", env: "AETHER_PLATFORMIO_CLI", defaultExecutable: "platformio", versionArgs: ["--version"],
  description: "构建、上传和生成编译数据库所用的 PlatformIO Core 可执行文件。",
};

type ProjectConfig = [string, [string, unknown][]][];

const invalidEnvironment = (name: string) => !name || name.includes("/") || name.includes("\\") || name === "..";

// PlatformIO Core本身负责解析 platformio.ini；这里只读取 `project config --json-output` 的结果，不执行自定义发现脚本。
export async function projectConfig(root: string, executable: string): Promise<ProjectConfig> {
  const output = await promisify(execFile)(executable, ["project", "config", "--json-output"], { cwd: root, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
  let parsed: unknown;
  try { parsed = JSON.parse(output.stdout); } catch (error) { throw new Error("无法解析 PlatformIO 工程配置：" + String(error)); }
  if (!Array.isArray(parsed)) throw new Error("PlatformIO 工程配置格式不是数组");
  const config = parsed as ProjectConfig;
  for (const section of config) {
    if (!Array.isArray(section) || typeof section[0] !== "string" || !Array.isArray(section[1]) || section[1].some((entry) => !Array.isArray(entry) || typeof entry[0] !== "string")) throw new Error("PlatformIO 工程配置条目格式错误");
  }
  return config;
}

function defaults(config: ProjectConfig) {
  const settings = config.find(([name]) => name === "platformio")?.[1];
  const value = settings?.find(([name]) => name === "default_envs")?.[1];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("platformio.ini 的 default_envs 不是字符串列表");
  return value as string[];
}

export async function platformioEnvironments(root: string, executable: string): Promise<TaskEnvironment[]> {
  const config = await projectConfig(root, executable);
  const declared = defaults(config);
  const names = config.filter(([name]) => name.startsWith("env:")).map(([name]) => name.slice(4));
  for (const name of names) if (invalidEnvironment(name)) throw new Error("无效的构建环境名：" + name);
  for (const name of declared) if (!names.includes(name)) throw new Error("default_envs 引用了不存在或无效的环境：" + name);
  // 未声明 default_envs 时 PlatformIO 会构建所有环境，因此每个环境都按默认处理；界面默认选第一个。
  return names.map((name) => ({ name, default: declared.length ? declared.includes(name) : true }));
}

// Runs one PlatformIO command as part of a task and kills its process tree when the task is cancelled.
function collect(executable: string, args: string[], root: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true, detached: process.platform !== "win32" });
    let stdout = ""; let stderr = ""; let settled = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    };
    const finish = (error: Error | null) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(stdout);
    };
    const aborted = () => { stop(); finish(new Error("任务已取消")); };
    const timer = setTimeout(() => { stop(); finish(new Error("PlatformIO 元数据命令超时")); }, 30000);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 4 * 1024 * 1024) { stop(); finish(new Error("PlatformIO 元数据输出过大")); } });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(code === 0 ? null : new Error("PlatformIO project metadata 退出码 " + code + "：" + stderr.slice(-2000))));
  });
}

// PlatformIO's own metadata command resolves cc_path/cxx_path for exactly one environment.
// It runs only from the explicit compiledb task: `project metadata` re-runs integration scripts.
async function toolchainMetadata(root: string, executable: string, environment: string, signal: AbortSignal) {
  const output = await collect(executable, ["project", "metadata", "--json-output", "-e", environment], root, signal);
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch (error) { throw new Error("无法解析 PlatformIO 环境元数据：" + String(error)); }
  const entry = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, { cc_path?: unknown; cxx_path?: unknown }>)[environment] : undefined;
  if (!entry || typeof entry !== "object") throw new Error("PlatformIO 未返回环境 " + environment + " 的元数据");
  const drivers = [entry.cc_path, entry.cxx_path].filter((value): value is string => typeof value === "string" && value.length > 0);
  return { environment, drivers, resolvedAt: new Date().toISOString(), source: "platformio project metadata -e " + environment };
}

function requireEnvironment(options: Record<string, string>) {
  const environment = options.environment?.trim();
  if (!environment) throw new Error("未选择 PlatformIO 构建环境");
  return environment;
}

export function createPlatformioPlugins(tool: ToolService): { platformioBuild: TaskProvider; platformioUpload: TaskProvider; platformioCompileDatabase: TaskProvider } {
  tool.define(platformioTool);
  const build: TaskProvider = {
    id: "platformio.build", executable: () => tool.executable("platformio"), args: (options) => ["run", "-e", requireEnvironment(options)], versionArgs: ["--version"],
    environments: (root, executable) => platformioEnvironments(root, executable),
    async artifacts(root, _executable, options) {
      const environment = requireEnvironment(options);
      const directory = path.join(root, ".pio", "build", environment);
      let entries: string[];
      try { entries = await fs.readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("环境 " + environment + " 没有构建目录 .pio/build/" + environment + "，请先构建该环境"); throw error; }
      const result: string[] = [];
      for (const file of entries) if (/\.(elf|bin|hex)$/.test(file) || file === "program" || file === "program.exe") result.push(".pio/build/" + environment + "/" + file);
      return result;
    },
  };
  const uploadArgs = (options: Record<string, string>) => {
    if (!options.port?.trim()) throw new Error("请明确选择烧录端口");
    return ["run", "-e", requireEnvironment(options), "--target", "upload", "--upload-port", options.port.trim()];
  };
  const upload: TaskProvider = {
    ...build, id: "platformio.upload", portOption: "port",
    args: uploadArgs,
    // ESP projects are refused here so a renderer cannot bypass the verified esptool write path.
    // Non-ESP builds keep exactly their previous behaviour.
    async prepare(root, executable, options) {
      const args = uploadArgs(options);
      const environment = options.environment?.trim() ?? "";
      try {
        const config = await projectConfig(root, executable);
        const platform = config.find(([name]) => name === "env:" + environment)?.[1].find(([name]) => name === "platform")?.[1];
        if (typeof platform === "string" && platform.split("@")[0].trim() === "espressif32") {
          throw new Error("ESP 工程必须通过 esp.upload 上传：写入前要在同一端口锁内核对芯片、分区与写前快照。请使用 Deploy to Device。");
        }
      } catch (error) {
        // Only a confirmed ESP target is rejected; an unreadable project still fails in PlatformIO itself.
        if (error instanceof Error && error.message.includes("esp.upload")) throw error;
      }
      return { args };
    },
  };
  const compiledb: TaskProvider = {
    ...build, id: "platformio.compiledb", kind: "compile-database", args: (options) => ["run", "-e", requireEnvironment(options), "--target", "compiledb"],
    inputExcludes: ["compile_commands.json"], recordName: "compiledb.json",
    artifacts: async () => ["compile_commands.json"],
    afterSuccess: (root, executable, options, signal) => toolchainMetadata(root, executable, requireEnvironment(options), signal),
  };
  return { platformioBuild: build, platformioUpload: upload, platformioCompileDatabase: compiledb };
}
