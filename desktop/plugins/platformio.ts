import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { TaskProvider } from "../tasks";
export const platformioBuild: TaskProvider = {
  id: "platformio.build", executable: process.env.AETHER_PLATFORMIO_CLI || "platformio", args: ["run"], versionArgs: ["--version"],
  async artifacts(root) {
    const output = await promisify(execFile)(platformioBuild.executable, ["project", "config", "--json-output"], { cwd: root, timeout: 10000 });
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

export const platformioUpload: TaskProvider = {
  ...platformioBuild, id: "platformio.upload",
  args: ({ port }) => { if (!port?.trim()) throw new Error("请明确选择烧录端口"); return ["run", "--target", "upload", "--upload-port", port]; },
};

export const platformioCompileDatabase: TaskProvider = {
  ...platformioBuild, id: "platformio.compiledb", args: ["run", "--target", "compiledb"],
  inputExcludes: ["compile_commands.json"], recordName: "compiledb.json",
  artifacts: async () => ["compile_commands.json"],
};
