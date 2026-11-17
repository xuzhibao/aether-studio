import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceService } from "../desktop/workspace";
import { TaskService } from "../desktop/tasks";
import { ToolService } from "../desktop/tools";
import { createPlatformioPlugins } from "../desktop/plugins/platformio";
import { createClangdProvider } from "../desktop/plugins/clangd";
import { LanguageService } from "../desktop/language";
import type { CompletionItem, CompletionList, DefinitionTarget, Hover, LanguageSnapshot } from "../shared/language";

// Real ESP32-S3 PlatformIO project: the compilation database and clangd must carry the Xtensa target,
// not a host stand-in. Requires PlatformIO with espressif32 and clangd 20+ (Xtensa support landed in LLVM 20).
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp32-"));
const file = "src/main.cpp";
const source = `#include <Arduino.h>
#include "sensor.h"

void setup() {
    Serial.begin(115200);
}

void loop() {
    Serial.println(sensor_value(1));
    delay(1000);
}
`;
const events: LanguageSnapshot[] = [];
const workspace = new WorkspaceService(); const tasks = new TaskService(workspace);
const tools = new ToolService(() => path.join(root, "tool-settings.json"));
const platformio = createPlatformioPlugins(tools);
const service = new LanguageService(workspace, (snapshot) => events.push(snapshot));
const clangd = createClangdProvider(tools);
tasks.register(platformio.platformioBuild); tasks.register(platformio.platformioCompileDatabase);
const waitTask = async (id: string) => {
  for (let n = 0; n < 3600; n++) {
    const task = tasks.list().find((item) => item.id === id)!;
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PlatformIO task timeout");
};
const document = (version?: number) => service.get()?.documents.find((item) => item.file === file && (version === undefined || item.version === version));
const until = async (condition: () => boolean, label: string) => {
  for (let n = 0; n < 300; n++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(label + ": " + JSON.stringify(service.get()));
};
try {
  await fs.cp("examples/platformio-esp32s3", root, { recursive: true, filter: (source) => !source.split(path.sep).includes(".pio") });
  await fs.writeFile(path.join(root, "src/sensor.h"), "#pragma once\ninline int sensor_value(int input) { return input + 1; }\n");
  await fs.writeFile(path.join(root, file), source);

  const resolved = tools.resolve("clangd").executable;
  const version = await promisify(execFile)(resolved, ["--version"], { timeout: 8000 }).then((result) => result.stdout + result.stderr);
  const major = Number(/clangd version (\d+)/.exec(version)?.[1] ?? 0);
  assert.ok(major >= 20, "Xtensa requires clangd 20 or newer; found: " + version.trim());

  await workspace.open(root); const canonical = workspace.root!;
  const database = await waitTask((await tasks.start("platformio.compiledb", { environment: "esp32-s3" })).id);
  assert.equal(database.status, "succeeded", database.error + "\n" + database.log);
  assert.equal(database.environment, "esp32-s3");
  const compileCommands = JSON.parse(await fs.readFile(path.join(root, "compile_commands.json"), "utf8")) as { file: string; command: string }[];
  const mainEntry = compileCommands.find((entry) => entry.file.endsWith("main.cpp"));
  assert.ok(mainEntry, "compile_commands.json must contain src/main.cpp");
  assert.match(mainEntry.command, /xtensa-esp32s3-elf-g\+\+/, "the database must compile for the ESP32-S3 Xtensa target");
  assert.match(mainEntry.command, /-mlongcalls|esp32s3/);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".aether/compiledb.json"), "utf8")).environment, "esp32-s3");

  service.register(clangd);
  const session = await service.start("clangd", canonical, { environment: "esp32-s3" });
  assert.equal(session.status, "ready"); assert.equal(session.compileDatabase, "ready"); assert.equal(session.environment, "esp32-s3");
  assert.ok(session.args.some((arg) => arg === "--compile-commands-dir=" + canonical));

  await service.open(session.id, file, source, 1);
  const lines = source.split("\n"); const lineIndex = lines.findIndex((item) => item.includes("sensor_value"));
  const position = { line: lineIndex, character: lines[lineIndex].indexOf("sensor_value") + 3 };
  const hover = await service.request(session.id, file, 1, "hover", position) as Hover;
  assert.match(JSON.stringify(hover.contents), /sensor_value/);
  const definitions = await service.request(session.id, file, 1, "definition", position) as DefinitionTarget[];
  assert.equal(definitions[0].file, "src/sensor.h");
  const completionLine = "void loop() { Serial. }";
  const completionText = source.replace("    Serial.println(sensor_value(1));", "    Serial.;");
  await service.change(session.id, file, completionText, 2);
  const completion = await service.request(session.id, file, 2, "completion", { line: lineIndex + 1, character: "    Serial.".length }) as CompletionItem[] | CompletionList;
  const items = Array.isArray(completion) ? completion : completion.items;
  assert.ok(items.some((item) => item.label === "println" || item.label === "begin"), "Arduino Serial members come from the SDK: " + completionLine);
  const diagnostics = document(2)?.diagnostics ?? [];
  assert.ok(!diagnostics.some((item) => item.severity === 1 && /Arduino\.h|sensor\.h|not found|unknown target|xtensa/i.test(item.message)), JSON.stringify(diagnostics));

  // Diagnostics must react to real C++ errors while compiled with the ESP32-S3 flags.
  await service.change(session.id, file, "#include <Arduino.h>\nvoid setup( { }\n", 3);
  await until(() => (document(3)?.diagnostics ?? []).some((item) => item.severity === 1), "expected a syntax error from clangd");
  await service.change(session.id, file, source, 4);
  await until(() => (document(4)?.diagnostics ?? []).every((item) => item.severity !== 1), "errors must clear after restoring valid code");

  // The same project with the explicit query-driver opt-in: only the exact Xtensa compiler from the selected environment.
  const authorized = await service.restart(session.id, { environment: "esp32-s3", queryDriver: true });
  assert.equal(authorized.compileDatabase, "ready");
  assert.ok(authorized.queryDrivers.length >= 1, "the selected environment's compiler must be resolved: " + JSON.stringify(authorized));
  for (const driver of authorized.queryDrivers) {
    assert.match(driver, /xtensa-esp32s3-elf-(g\+\+|gcc)(\.exe)?$/, driver);
    assert.match(driver.replaceAll("\\", "/"), /\.platformio\/packages\//, "only PlatformIO core compilers are allowed: " + driver);
  }
  assert.ok(authorized.args.some((arg) => arg === "--query-driver=" + authorized.queryDrivers.join(",")));
  await service.open(authorized.id, file, source, 1);
  const second = await service.request(authorized.id, file, 1, "hover", position) as Hover;
  assert.match(JSON.stringify(second.contents), /sensor_value/);
  await until(() => (document(1)?.diagnostics ?? []).every((item) => item.severity !== 1), "query-driver must keep ESP32 diagnostics clean");
  await service.close(authorized.id, file);
  await service.stop(authorized.id);
  console.log("PASS esp32: real ESP32-S3 PlatformIO compiledb pinned to env esp32-s3, Xtensa compiler in database, clangd " + major + " Arduino/SDK hover, completion, project definition, live diagnostics and explicit query-driver allow-list; no hardware");
} finally { await service.stop(); await tasks.stopAll(); await workspace.close(); await fs.rm(root, { recursive: true, force: true }); }
