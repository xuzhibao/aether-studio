import path from "node:path";
import { explicitMicropythonFile, explicitMicropythonPort, micropythonRunArgs, MICROPYTHON_RUN_PROVIDER } from "../../shared/micropython";
import type { TaskProvider } from "../tasks";
import type { ToolDefinition, ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";
import { findPythonFor } from "./esptool";

// mpremote is a Python entry point. A user may configure the pip-generated executable (the normal
// case) or a real mpremote.py; the latter is launched through an interpreter, never through a shell.
export const micropythonTool: ToolDefinition = {
  id: "mpremote",
  name: "mpremote",
  env: "AETHER_MPREMOTE",
  defaultExecutable: "mpremote",
  versionArgs: ["--version"],
  launch: (file) => /[.]py$/i.test(file) ? { executable: process.env.AETHER_MPREMOTE_PYTHON?.trim() || findPythonFor(file), args: [file] } : null,
  description: "在已安装 MicroPython 的设备上运行本地 .py 文件所用的官方 mpremote 可执行文件。",
};

/** Resolves the configured mpremote once per task; a script entry also carries its interpreter prefix. */
export function resolveMicropythonCommand(tools: ToolService) {
  const executable = tools.executable("mpremote");
  const launch = micropythonTool.launch?.(executable);
  if (launch) {
    if (!launch.executable) throw new Error("mpremote.py 需要 Python 解释器，但未找到。请在插件设置中直接填写 mpremote 可执行文件，或安装 Python。");
    return { executable: launch.executable, prefix: launch.args };
  }
  return { executable, prefix: [] as string[] };
}

export function createMicropythonRunProvider(tools: ToolService, workspace: WorkspaceService): TaskProvider {
  tools.define(micropythonTool);
  return {
    id: MICROPYTHON_RUN_PROVIDER,
    kind: "device-run",
    // The real executable and argv are produced in prepare(), after the port lease is held.
    executable: () => resolveMicropythonCommand(tools).executable,
    args: () => { throw new Error("MicroPython 运行的参数在端口和文件校验后生成"); },
    portOption: "port",
    async prepare(root, _executable, options, _signal, log) {
      const port = explicitMicropythonPort(options.port);
      const file = explicitMicropythonFile(options.file);
      // Reuse the loaded disk listing: it excludes cache directories, symlinks, binary and oversized
      // files that the project explorer cannot represent. A buffer that only exists in the editor is
      // not in this listing, so this also enforces "only a saved file".
      const listing = await workspace.listing();
      if (!Object.hasOwn(listing.files, file)) throw new Error("工程磁盘上没有这个已保存的 .py 文件：" + file + "。请先保存后再运行。");
      const command = resolveMicropythonCommand(tools);
      const absolute = path.join(root, file);
      log("[aether] 运行已保存的 " + file + "（端口 " + port + "）；不安装固件，不向板上持久上传文件。");
      return { executable: command.executable, args: [...command.prefix, ...micropythonRunArgs(port, absolute)] };
    },
  };
}
