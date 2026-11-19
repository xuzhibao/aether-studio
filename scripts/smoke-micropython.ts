import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskService } from "../desktop/tasks";
import { ToolService } from "../desktop/tools";
import { WorkspaceService } from "../desktop/workspace";
import { isPortBusy, portOwner, withPort } from "../desktop/portLease";
import { createMicropythonRunProvider, micropythonTool } from "../desktop/plugins/micropython";
import { explicitMicropythonFile, explicitMicropythonPort, micropythonRunArgs } from "../shared/micropython";
import { mergeTaskList } from "../src/lib/tasks";
import type { TaskSnapshot } from "../shared/desktop";

// Regression for the MicroPython run entry: a real mpremote version probe (when installed), plus a
// file-backed fake CLI covering exact argv, root/digest binding, the private temp copy, concurrency,
// cancellation and a non-zero exit. No serial port is opened and no board is touched.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-"));
const project = path.join(root, "project");
const projectB = path.join(root, "project-b");
const fake = path.resolve("scripts/fixtures/fake-mpremote.py");
const logPath = path.join(root, "fake-mpremote-calls.log");
const workspace = new WorkspaceService();
const tasks = new TaskService(workspace);
const tools = new ToolService(() => path.join(root, "tools.json"));

const waitTask = async (id: string) => {
  for (let n = 0; n < 600; n++) {
    const task = tasks.list().find((item) => item.id === id);
    if (task && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("task timeout: " + id);
};
const calls = async () => (await fs.readFile(logPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const runCalls = async () => (await calls()).filter((entry) => !entry.version);
const nextCall = async (index: number) => { for (let n = 0; n < 200; n++) { const all = await runCalls(); if (all.length > index) return all[index]; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("fake mpremote did not log run call " + index); };
const clearFakeEnv = () => { for (const key of Object.keys(process.env)) if (key.startsWith("AETHER_FAKE_MPREMOTE_")) delete process.env[key]; };
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const shaOf = async (file: string) => sha256(await fs.readFile(file));
const taskSnapshot = (status: "running" | "succeeded", exitCode: number | null): TaskSnapshot => ({ id: "task", provider: "micropython.run", root: "C:/project", status, startedAt: "2026-01-01T00:00:00.000Z", exitCode, log: "", inputHash: "", artifacts: [] });

try {
  await fs.mkdir(path.join(project, "lib"), { recursive: true });
  const originalMain = 'print("hello from the fake board")\n';
  await fs.writeFile(path.join(project, "main.py"), originalMain);
  await fs.writeFile(path.join(project, "lib", "helper.py"), 'print("helper")\n');
  await fs.writeFile(path.join(project, "notes.txt"), "not python\n");
  await fs.mkdir(projectB, { recursive: true });
  await fs.writeFile(path.join(projectB, "main.py"), 'print("same name in another project")\n');
  await workspace.open(project);
  const projectRoot = workspace.root!;
  let mainSha = await shaOf(path.join(project, "main.py"));
  const helperSha = await shaOf(path.join(project, "lib", "helper.py"));
  const optionsFor = async (file: string, port = "COM_TEST") => ({ port, file, root: projectRoot, sha256: await shaOf(path.join(projectRoot, file)) });

  // ---- fixed argv and input validation ----
  assert.deepEqual(micropythonRunArgs("COM_TEST", path.join(project, "main.py")), ["connect", "port:COM_TEST", "run", path.join(project, "main.py")]);
  assert.equal(explicitMicropythonPort(" COM_TEST "), "COM_TEST");
  for (const value of ["", "auto", "AUTO", "list", "COM3; rm", "COM3 run evil.py", "COM3&calc", "COM3\nrun"]) {
    assert.throws(() => explicitMicropythonPort(value), /端口|auto|list/, "port must be explicit: " + JSON.stringify(value));
  }
  assert.equal(explicitMicropythonFile("lib/helper.py"), "lib/helper.py");
  for (const value of ["", "../main.py", "/main.py", "C:\\\\main.py", "lib\\\\helper.py", "notes.txt"]) {
    assert.throws(() => explicitMicropythonFile(value), /\.py|相对|工程/, "file must be a saved project .py: " + JSON.stringify(value));
  }
  console.log("PASS micropython: fixed argv and explicit port/file validation");

  // ---- tool status through the shared ToolService, including --version ----
  tools.define(micropythonTool);
  await tools.load();
  await tools.setPath("mpremote", fake);
  const fakeStatus = await tools.status("mpremote", true);
  assert.equal(fakeStatus.available, true, fakeStatus.error);
  assert.equal(fakeStatus.version, "mpremote 9.9.9", "the version probe runs the fake CLI's --version");
  console.log("PASS micropython: mpremote tool status and --version probe");

  const provider = createMicropythonRunProvider(tools, workspace);
  tasks.register(provider);
  const prepared = await provider.prepare!(projectRoot, tools.executable("mpremote"), { port: "COM_TEST", file: "lib/helper.py", root: projectRoot, sha256: helperSha }, new AbortController().signal, () => {});
  assert.ok(prepared.executable, "a .py entry point must resolve an interpreter");
  assert.equal(prepared.args[0], fake, "the .py entry point is passed as one literal script argument");
  assert.deepEqual(prepared.args.slice(1, 4), ["connect", "port:COM_TEST", "run"]);
  const preparedTemp = prepared.args[4];
  assert.ok(preparedTemp.includes("aether-micropython-run-") && preparedTemp.endsWith("script.py"), "the run uses an independent temp .py: " + preparedTemp);
  assert.notEqual(preparedTemp, path.join(projectRoot, "lib", "helper.py"));
  assert.equal(sha256(await fs.readFile(preparedTemp)), helperSha, "the temp copy is byte-identical to the reviewed file");
  await provider.afterRun?.();
  assert.equal(await fs.stat(preparedTemp).catch(() => null), null, "a prepared-only run is cleaned up");
  console.log("PASS micropython: provider prepares a verified private copy with plain connect/run argv");

  // ---- normal run: exact argv, real exit code, private copy, no artifact record ----
  clearFakeEnv(); process.env.AETHER_FAKE_MPREMOTE_LOG = logPath; process.env.AETHER_FAKE_MPREMOTE_MODE = "ok";
  const success = await waitTask((await tasks.start("micropython.run", await optionsFor("lib/helper.py"))).id);
  assert.equal(success.status, "succeeded", success.log + "\n" + (success.error ?? ""));
  assert.equal(success.exitCode, 0);
  assert.equal(success.artifacts.length, 0, "a run task has no build artifact");
  assert.match(success.log, /\[fake-mpremote\] ran .*script\.py/);
  assert.equal(await fs.stat(path.join(project, ".aether")).catch(() => null), null, "a run task must not write a build record");
  const successCall = await nextCall(0);
  assert.deepEqual(successCall.argv.slice(0, 3), ["connect", "port:COM_TEST", "run"]);
  assert.equal(successCall.file, successCall.argv[3]);
  assert.ok(successCall.file.includes("aether-micropython-run-"), "mpremote runs the private temp copy");
  assert.equal(successCall.fileSha256, helperSha, "the executed bytes have the reviewed digest");
  const successMetadata = success.metadata as { sourceFile?: string; sourceSha256?: string; tempFile?: string };
  assert.equal(successMetadata.sourceFile, "lib/helper.py");
  assert.equal(successMetadata.sourceSha256, helperSha);
  assert.equal(await fs.stat(successMetadata.tempFile!).catch(() => null), null, "the private copy is removed when the task ends");
  assert.equal(portOwner("COM_TEST"), null);
  console.log("PASS micropython: saved .py runs from a verified temp copy, exit 0, then the copy is removed");

  // ---- validation is repeated inside the task, after the port lease is held ----
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "missing.py", root: projectRoot, sha256: mainSha }), /磁盘上没有这个已保存/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "notes.txt", root: projectRoot, sha256: mainSha }), /只能运行 \.py/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "auto", file: "main.py", root: projectRoot, sha256: mainSha }), /不能使用 auto 或 list/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "../outside.py", root: projectRoot, sha256: mainSha }), /相对 \.py/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "main.py" }), /预期工程目录/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "main.py", root: projectRoot }), /SHA-256/);
  assert.equal(isPortBusy("COM_TEST"), false, "a refused start must not keep the port");
  console.log("PASS micropython: missing/non-.py/auto/traversal/root/digest inputs are refused before spawn");

  // ---- an external edit after review is refused with zero fake calls ----
  const beforeExternal = (await runCalls()).length;
  await fs.writeFile(path.join(project, "main.py"), 'print("changed externally")\n');
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "main.py", root: projectRoot, sha256: mainSha }), /文件在核对后发生变化/);
  assert.equal((await runCalls()).length, beforeExternal, "a stale digest must not invoke mpremote");
  await fs.writeFile(path.join(project, "main.py"), originalMain);
  mainSha = await shaOf(path.join(project, "main.py"));
  console.log("PASS micropython: an external edit after review is refused with zero mpremote calls");

  // ---- a project switch with the same file name is refused with zero fake calls ----
  const beforeSwitch = (await runCalls()).length;
  await workspace.open(projectB);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "main.py", root: projectRoot, sha256: mainSha }), /工程目录在运行前发生变化/);
  assert.equal((await runCalls()).length, beforeSwitch, "a project switch must not invoke mpremote");
  await workspace.open(project);
  assert.equal(workspace.root, projectRoot);
  console.log("PASS micropython: a project switch with the same file name is refused with zero mpremote calls");

  // ---- concurrency: a running task holds the lease and no second task may start ----
  process.env.AETHER_FAKE_MPREMOTE_MODE = "slow";
  const slow = await tasks.start("micropython.run", await optionsFor("main.py"));
  await nextCall(1);
  assert.equal(portOwner("COM_TEST"), "task");
  assert.equal(isPortBusy("COM_TEST"), true);
  const secondOptions = await optionsFor("main.py", "COM_TEST2");
  await assert.rejects(() => tasks.start("micropython.run", secondOptions), /已有任务运行/);
  await assert.rejects(() => withPort("COM_TEST", "monitor", async () => {}), /构建\/上传任务占用/);
  await tasks.cancel(slow.id);
  const cancelled = tasks.list().find((task) => task.id === slow.id);
  assert.equal(cancelled?.status, "cancelled");
  const cancelledTemp = (cancelled?.metadata as { tempFile?: string } | undefined)?.tempFile;
  assert.ok(cancelledTemp, "the cancelled task recorded its private copy");
  assert.equal(await fs.stat(cancelledTemp).catch(() => null), null, "cancellation removes the private copy");
  assert.equal(isPortBusy("COM_TEST"), false, "cancellation must release the port");
  console.log("PASS micropython: concurrent run is refused and cancellation releases the shared port lease");

  // ---- abnormal exit keeps the real exit code and stderr ----
  process.env.AETHER_FAKE_MPREMOTE_MODE = "fail";
  const failed = await waitTask((await tasks.start("micropython.run", await optionsFor("main.py"))).id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 3);
  assert.match(failed.log, /could not open port COM_TEST/);
  const failedTemp = (failed.metadata as { tempFile?: string } | undefined)?.tempFile;
  assert.ok(failedTemp, "the failed task recorded its private copy");
  assert.equal(await fs.stat(failedTemp).catch(() => null), null, "a failed task removes the private copy");
  assert.equal(isPortBusy("COM_TEST"), false);
  console.log("PASS micropython: abnormal exit reports exit code 3 and the real stderr without claiming success");

  // ---- a start reply must never regress an already delivered terminal snapshot ----
  const finished = taskSnapshot("succeeded", 0);
  assert.equal(mergeTaskList([finished], taskSnapshot("running", null))[0].status, "succeeded");
  assert.equal(mergeTaskList([taskSnapshot("running", null)], finished)[0].status, "succeeded");
  console.log("PASS micropython: a late tasks:start reply keeps an existing terminal task state");

  // ---- real mpremote CLI version, when one is available ----
  const realTools = new ToolService(() => path.join(root, "real-tools.json"));
  realTools.define(micropythonTool);
  const realStatus = await realTools.status("mpremote", true);
  if (!realStatus.available) {
    console.log("SKIP micropython: real mpremote --version (" + realStatus.error + ")");
  } else if (/fake-mpremote/i.test(realStatus.executable)) {
    console.log("SKIP micropython: real mpremote --version (AETHER_MPREMOTE points at the fixture)");
  } else {
    assert.match(realStatus.version, /^mpremote\s+\d+\.\d+\.\d+/, "real mpremote --version output: " + realStatus.version);
    console.log("PASS micropython: real mpremote --version -> " + realStatus.version + " (" + realStatus.executable + ")");
  }
} finally {
  clearFakeEnv();
  await tasks.stopAll().catch(() => {});
  await workspace.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
