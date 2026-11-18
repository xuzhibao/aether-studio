import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskService } from "../desktop/tasks";
import { ToolService } from "../desktop/tools";
import { WorkspaceService } from "../desktop/workspace";
import { isPortBusy, portOwner, withPort } from "../desktop/portLease";
import { createMicropythonRunProvider, micropythonTool } from "../desktop/plugins/micropython";
import { explicitMicropythonFile, explicitMicropythonPort, micropythonRunArgs } from "../shared/micropython";

// Regression for the MicroPython run entry: a real mpremote version probe (when installed), plus a
// file-backed fake CLI covering exact argv, concurrency, cancellation and a non-zero exit. No serial
// port is opened and no board is touched.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-"));
const project = path.join(root, "project");
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

try {
  await fs.mkdir(path.join(project, "lib"), { recursive: true });
  await fs.writeFile(path.join(project, "main.py"), 'print("hello from the fake board")\n');
  await fs.writeFile(path.join(project, "lib", "helper.py"), 'print("helper")\n');
  await fs.writeFile(path.join(project, "notes.txt"), "not python\n");
  await workspace.open(project);

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
  const prepared = await provider.prepare!(project, tools.executable("mpremote"), { port: "COM_TEST", file: "lib/helper.py" }, new AbortController().signal, () => {});
  assert.ok(prepared.executable, "a .py entry point must resolve an interpreter");
  assert.equal(prepared.args[0], fake, "the .py entry point is passed as one literal script argument");
  assert.deepEqual(prepared.args.slice(-4), ["connect", "port:COM_TEST", "run", path.join(project, "lib", "helper.py")]);
  console.log("PASS micropython: provider prepares only connect port:<explicit> run <project file>");

  // ---- normal run: exact argv, real exit code, no artifact record ----
  clearFakeEnv(); process.env.AETHER_FAKE_MPREMOTE_LOG = logPath; process.env.AETHER_FAKE_MPREMOTE_MODE = "ok";
  const success = await waitTask((await tasks.start("micropython.run", { port: "COM_TEST", file: "lib/helper.py" })).id);
  assert.equal(success.status, "succeeded", success.log + "\n" + (success.error ?? ""));
  assert.equal(success.exitCode, 0);
  assert.equal(success.artifacts.length, 0, "a run task has no build artifact");
  assert.match(success.log, /\[fake-mpremote\] ran .*helper\.py/);
  assert.equal(await fs.stat(path.join(project, ".aether")).catch(() => null), null, "a run task must not write a build record");
  const successCall = await nextCall(0);
  assert.deepEqual(successCall.argv, ["connect", "port:COM_TEST", "run", path.join(project, "lib", "helper.py")]);
  assert.equal(successCall.port, "COM_TEST");
  assert.equal(portOwner("COM_TEST"), null);
  console.log("PASS micropython: saved .py runs with exact argv, exit code 0 and no build record");

  // ---- validation is repeated inside the task, after the port lease is held ----
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "missing.py" }), /磁盘上没有这个已保存/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "notes.txt" }), /只能运行 \.py/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "auto", file: "main.py" }), /不能使用 auto 或 list/);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST", file: "../outside.py" }), /相对 \.py/);
  assert.equal(isPortBusy("COM_TEST"), false, "a refused start must not keep the port");
  console.log("PASS micropython: missing/dirty/non-.py/auto/traversal inputs are refused before spawn");

  // ---- concurrency: a running task holds the lease and no second task may start ----
  process.env.AETHER_FAKE_MPREMOTE_MODE = "slow";
  const slow = await tasks.start("micropython.run", { port: "COM_TEST", file: "main.py" });
  await nextCall(1);
  assert.equal(portOwner("COM_TEST"), "task");
  assert.equal(isPortBusy("COM_TEST"), true);
  await assert.rejects(() => tasks.start("micropython.run", { port: "COM_TEST2", file: "main.py" }), /已有任务运行/);
  await assert.rejects(() => withPort("COM_TEST", "monitor", async () => {}), /task/);
  await tasks.cancel(slow.id);
  assert.equal(tasks.list().find((task) => task.id === slow.id)?.status, "cancelled");
  assert.equal(isPortBusy("COM_TEST"), false, "cancellation must release the port");
  console.log("PASS micropython: concurrent run is refused and cancellation releases the shared port lease");

  // ---- abnormal exit keeps the real exit code and stderr ----
  process.env.AETHER_FAKE_MPREMOTE_MODE = "fail";
  const failed = await waitTask((await tasks.start("micropython.run", { port: "COM_TEST", file: "main.py" })).id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 3);
  assert.match(failed.log, /could not open port COM_TEST/);
  assert.equal(isPortBusy("COM_TEST"), false);
  console.log("PASS micropython: abnormal exit reports exit code 3 and the real stderr without claiming success");

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
