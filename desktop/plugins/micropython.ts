import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
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

const digestPattern = /^[0-9a-f]{64}$/i;
const sameRoot = (a: string, b: string) => process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
function expectedRoot(value: string | undefined) {
  const root = value?.trim() ?? "";
  if (!root) throw new Error("缺少预期工程目录；已取消运行，未调用 mpremote");
  return path.resolve(root);
}
function expectedDigest(value: string | undefined) {
  const digest = value?.trim() ?? "";
  if (!digestPattern.test(digest)) throw new Error("缺少或无效的文件 SHA-256；已取消运行，未调用 mpremote");
  return digest.toLowerCase();
}

export function createMicropythonRunProvider(tools: ToolService, workspace: WorkspaceService): TaskProvider {
  tools.define(micropythonTool);
  let cleanup: (() => Promise<void>) | null = null;
  const discard = async () => {
    const current = cleanup;
    cleanup = null;
    if (current) await current();
  };
  return {
    id: MICROPYTHON_RUN_PROVIDER,
    kind: "device-run",
    // The real executable and argv are produced in prepare(), after the port lease is held.
    executable: () => resolveMicropythonCommand(tools).executable,
    args: () => { throw new Error("MicroPython 运行的参数在端口和文件校验后生成"); },
    portOption: "port",
    // The private copy is removed on success, failure, cancellation and a failed start.
    async afterRun() { await discard().catch(() => {}); },
    async prepare(root, _executable, options, _signal, log) {
      await discard().catch(() => {});
      const port = explicitMicropythonPort(options.port);
      const file = explicitMicropythonFile(options.file);
      const reviewedRoot = expectedRoot(options.root);
      const reviewedDigest = expectedDigest(options.sha256);

      // Every await below happens while this task owns the port. Root and digest bind the run to what
      // the UI reviewed, not to whatever file currently has the same name.
      if (!workspace.root || !sameRoot(path.resolve(root), reviewedRoot) || !sameRoot(path.resolve(workspace.root), reviewedRoot)) {
        throw new Error("工程目录在运行前发生变化；已取消，未调用 mpremote。请重新打开工程并选择文件。");
      }
      // Reuse the loaded disk listing: it excludes cache directories, symlinks, binary and oversized
      // files that the project explorer cannot represent. A buffer that only exists in the editor is
      // not in this listing, so this also enforces "only a saved file".
      const listing = await workspace.listing();
      if (!Object.hasOwn(listing.files, file)) throw new Error("工程磁盘上没有这个已保存的 .py 文件：" + file + "。请先保存后再运行。");
      const absolute = path.join(root, file);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("工程中的 .py 文件在运行前发生变化：" + file + "。请重新选择后再运行。");
      // Read and hash once; the same bytes are written to the private copy, so nothing can swap the
      // content between the digest check and what mpremote executes.
      const bytes = await fs.readFile(absolute).catch(() => null);
      if (!bytes) throw new Error("工程中的 .py 文件在运行前消失：" + file + "。请重新选择后再运行。");
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== reviewedDigest) throw new Error("文件在核对后发生变化；已取消，未调用 mpremote。请保存后重试。");
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-run-"));
      try { await fs.writeFile(path.join(directory, "script.py"), bytes, { mode: 0o600 }); }
      catch (error) { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
      cleanup = () => fs.rm(directory, { recursive: true, force: true });
      const command = resolveMicropythonCommand(tools);
      const temporary = path.join(directory, "script.py");
      log("[aether] 已核对 " + file + " 的 SHA-256 " + actualDigest.slice(0, 12) + "…；运行独立临时副本，任务结束即清理。");
      return {
        executable: command.executable,
        args: [...command.prefix, ...micropythonRunArgs(port, temporary)],
        metadata: { sourceFile: file, sourceSha256: actualDigest, tempFile: temporary },
      };
    },
  };
}
