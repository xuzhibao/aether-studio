import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
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
async function projectConfig(root: string, executable: string): Promise<ProjectConfig> {
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
  const upload: TaskProvider = {
    ...build, id: "platformio.upload",
    args: (options) => { if (!options.port?.trim()) throw new Error("请明确选择烧录端口"); return ["run", "-e", requireEnvironment(options), "--target", "upload", "--upload-port", options.port.trim()]; },
  };
  const compiledb: TaskProvider = {
    ...build, id: "platformio.compiledb", args: (options) => ["run", "-e", requireEnvironment(options), "--target", "compiledb"],
    inputExcludes: ["compile_commands.json"], recordName: "compiledb.json",
    artifacts: async () => ["compile_commands.json"],
  };
  return { platformioBuild: build, platformioUpload: upload, platformioCompileDatabase: compiledb };
}
