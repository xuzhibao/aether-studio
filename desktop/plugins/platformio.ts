import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TaskProvider } from "../tasks";
import type { ToolDefinition, ToolService } from "../tools";

// Public tool identity used by the PlatformIO plugin UI. Users configure this path in the app.
export const platformioTool: ToolDefinition = {
  id: "platformio", name: "PlatformIO Core CLI", env: "AETHER_PLATFORMIO_CLI", defaultExecutable: "platformio", versionArgs: ["--version"],
  description: "构建、上传和生成编译数据库所用的 PlatformIO Core 可执行文件。",
};

export function createPlatformioPlugins(tool: ToolService): { platformioBuild: TaskProvider; platformioUpload: TaskProvider; platformioCompileDatabase: TaskProvider } {
  tool.define(platformioTool);
  const build: TaskProvider = {
    id: "platformio.build", executable: () => tool.executable("platformio"), args: ["run"], versionArgs: ["--version"],
    async artifacts(root, executable) {
      const output = await promisify(execFile)(executable, ["project", "config", "--json-output"], { cwd: root, timeout: 10000 });
      const config = JSON.parse(output.stdout) as [string, [string, unknown][]][];
      const defaults = config.find(([name]) => name === "platformio")?.[1].find(([name]) => name === "default_envs")?.[1] as string[] | undefined;
      const environments = defaults ?? config.filter(([name]) => name.startsWith("env:")).map(([name]) => name.slice(4));
      const result: string[] = [];
      for (const env of environments) {
        if (!env || env.includes("/") || env.includes("\\") || env === "..") throw new Error("无效的构建环境名");
        for (const file of await fs.readdir(path.join(root, ".pio", "build", env))) {
          if (/\.(elf|bin|hex)$/.test(file) || file === "program" || file === "program.exe") result.push(".pio/build/" + env + "/" + file);
        }
      }
      return result;
    },
  };
  const upload: TaskProvider = {
    ...build, id: "platformio.upload",
    args: ({ port }) => { if (!port?.trim()) throw new Error("请明确选择烧录端口"); return ["run", "--target", "upload", "--upload-port", port]; },
  };
  const compiledb: TaskProvider = {
    ...build, id: "platformio.compiledb", args: ["run", "--target", "compiledb"],
    inputExcludes: ["compile_commands.json"], recordName: "compiledb.json",
    artifacts: async () => ["compile_commands.json"],
  };
  return { platformioBuild: build, platformioUpload: upload, platformioCompileDatabase: compiledb };
}
