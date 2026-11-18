import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceService } from "../desktop/workspace";
import { TaskService } from "../desktop/tasks";
import { ToolService } from "../desktop/tools";
import { createPlatformioPlugins } from "../desktop/plugins/platformio";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-platformio-"));
const workspace = new WorkspaceService(); const tasks = new TaskService(workspace);
const tools = new ToolService(() => path.join(root, "tool-settings.json"));
const platformio = createPlatformioPlugins(tools);
tasks.register(platformio.platformioBuild); tasks.register(platformio.platformioUpload); tasks.register(platformio.platformioCompileDatabase);
const ini = `[platformio]
default_envs = env-a

[env:env-a]
platform = native@1.2.1
build_flags = -std=c++17 -DAETHER_ENV_A

[env:env-b]
platform = native@1.2.1
build_flags = -std=c++17 -DAETHER_ENV_B
`;
const source = `#include <cstdio>
int main() { std::puts("aether"); return 0; }
`;
const wait = async (id: string) => {
  for (let n = 0; n < 3000; n++) {
    const task = tasks.list().find((item) => item.id === id)!;
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("task timeout: " + JSON.stringify(tasks.list().find((item) => item.id === id)));
};
try {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "platformio.ini"), ini);
  await fs.writeFile(path.join(root, "src/main.cpp"), source);
  await workspace.open(root);

  const environments = await tasks.environments("platformio.build");
  assert.deepEqual(environments, [{ name: "env-a", default: true }, { name: "env-b", default: false }], "default_envs must mark env-a only");
  await assert.rejects(() => tasks.start("platformio.build", { environment: "env-a/../env-b" }), /未知的构建环境/);
  await assert.rejects(() => tasks.start("platformio.build", { environment: "missing" }), /未知的构建环境/);
  await assert.rejects(() => tasks.start("platformio.upload", { environment: "env-b" }), /烧录端口/);

  // No explicit environment: the declared default is fixed and recorded before the process starts.
  const defaultTask = await wait((await tasks.start("platformio.build")).id);
  assert.equal(defaultTask.status, "succeeded", defaultTask.error + "\n" + defaultTask.log);
  assert.equal(defaultTask.environment, "env-a");
  assert.match(defaultTask.log.split("\n")[0], /run -e env-a$/);
  assert.ok(defaultTask.artifacts.length > 0);
  assert.ok(defaultTask.artifacts.every((artifact) => artifact.path.startsWith(".pio/build/env-a/")), JSON.stringify(defaultTask.artifacts));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".aether/build.json"), "utf8")).environment, "env-a");

  // A second environment: build with -e env-b, collect only env-b artifacts even though env-a's directory exists.
  const second = await wait((await tasks.start("platformio.build", { environment: "env-b" })).id);
  assert.equal(second.status, "succeeded", second.error + "\n" + second.log);
  assert.equal(second.environment, "env-b");
  assert.match(second.log.split("\n")[0], /run -e env-b$/);
  assert.ok(second.artifacts.length > 0);
  assert.ok(second.artifacts.every((artifact) => artifact.path.startsWith(".pio/build/env-b/")), JSON.stringify(second.artifacts));
  assert.ok(second.artifacts.every((artifact) => !artifact.path.includes("env-a/")));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".aether/build.json"), "utf8")).environment, "env-b");

  // The compilation database is generated for the selected environment only.
  const database = await wait((await tasks.start("platformio.compiledb", { environment: "env-b" })).id);
  assert.equal(database.status, "succeeded", database.error + "\n" + database.log);
  assert.equal(database.environment, "env-b");
  const databaseRecord = JSON.parse(await fs.readFile(path.join(root, ".aether/compiledb.json"), "utf8"));
  assert.equal(databaseRecord.environment, "env-b");
  // The compiler metadata is resolved inside the explicit task and cached; language start only reads it.
  assert.equal(databaseRecord.metadata.environment, "env-b");
  assert.ok(Array.isArray(databaseRecord.metadata.drivers) && databaseRecord.metadata.drivers.length >= 1, JSON.stringify(databaseRecord.metadata));
  const commands = JSON.parse(await fs.readFile(path.join(root, "compile_commands.json"), "utf8")) as { command: string }[];
  assert.ok(commands.every((entry) => entry.command.includes("AETHER_ENV_B")) && commands.every((entry) => !entry.command.includes("AETHER_ENV_A")), "compiledb must carry env-b flags");

  // A project without default_envs: PlatformIO builds every env, so every declared env is offered as default.
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "aether-platformio-plain-"));
  try {
    await fs.writeFile(path.join(plain, "platformio.ini"), "[env:one]\nplatform = native@1.2.1\n\n[env:two]\nplatform = native@1.2.1\n");
    await workspace.open(plain);
    assert.deepEqual(await tasks.environments("platformio.build"), [{ name: "one", default: true }, { name: "two", default: true }]);
  } finally { await workspace.close(); await fs.rm(plain, { recursive: true, force: true }); }
  console.log("PASS platformio environments: PlatformIO config discovery, default_envs, -e for build/compiledb, per-environment artifact collection and records, unknown/missing selections, upload port guard; no hardware");
} finally { await tasks.stopAll(); await workspace.close(); await fs.rm(root, { recursive: true, force: true }); }
