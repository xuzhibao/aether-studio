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
const lines = source.split("\n");
const valueLine = lines.findIndex((item) => item.includes("sensor_value"));
const valuePosition = { line: valueLine, character: lines[valueLine].indexOf("sensor_value") + 3 };
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
const errors = (version?: number) => (document(version)?.diagnostics ?? []).filter((item) => item.severity === 1);
try {
  await fs.cp("examples/platformio-esp32s3", root, { recursive: true, filter: (source) => !source.split(path.sep).includes(".pio") });
  await fs.writeFile(path.join(root, "src/sensor.h"), "#pragma once\ninline int sensor_value(int input) { return input + 1; }\n");
  await fs.writeFile(path.join(root, file), source);
  // PlatformIO re-runs integration scripts for project metadata; only the explicit compiledb task may do that.
  await fs.writeFile(path.join(root, "extra_marker.py"), "Import(\"env\")\nwith open(\"script_runs.txt\", \"a\") as log:\n    log.write(\"run\\n\")\n");
  const iniPath = path.join(root, "platformio.ini");
  await fs.writeFile(iniPath, (await fs.readFile(iniPath, "utf8")).trimEnd() + "\nextra_scripts = pre:extra_marker.py\n");

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
  const recordPath = path.join(root, ".aether/compiledb.json");
  const recordText = await fs.readFile(recordPath, "utf8");
  const record = JSON.parse(recordText);
  assert.equal(record.environment, "esp32-s3");
  assert.equal(record.metadata.environment, "esp32-s3");
  assert.ok(record.metadata.drivers.some((driver: string) => /xtensa-esp32s3-elf-g\+\+/.test(driver)), JSON.stringify(record.metadata));
  assert.ok(!record.metadataError, "compiler metadata must resolve during the explicit task: " + record.metadataError);
  const scriptRuns = await fs.readFile(path.join(root, "script_runs.txt"), "utf8");
  assert.ok(scriptRuns.includes("run"), "the explicit compiledb task runs the project's integration script");

  service.register(clangd);
  const session = await service.start("clangd", canonical, { environment: "esp32-s3" });
  assert.equal(session.status, "ready"); assert.equal(session.compileDatabase, "ready"); assert.equal(session.environment, "esp32-s3");
  assert.ok(session.args.some((arg) => arg === "--compile-commands-dir=" + canonical));
  assert.equal(await fs.readFile(path.join(root, "script_runs.txt"), "utf8"), scriptRuns, "starting clangd must not run PlatformIO or project scripts");

  const beforeOpen = session.diagnosticsReceived;
  await service.open(session.id, file, source, 1);
  const hover = await service.request(session.id, file, 1, "hover", valuePosition) as Hover;
  assert.match(JSON.stringify(hover.contents), /sensor_value/);
  const definitions = await service.request(session.id, file, 1, "definition", valuePosition) as DefinitionTarget[];
  assert.equal(definitions[0].file, "src/sensor.h");
  await until(() => (service.get()?.diagnosticsReceived ?? 0) > beforeOpen, "initial diagnostics event");
  assert.deepEqual(errors(1), [], "Arduino and project headers must resolve with the ESP32 database");

  // Arduino SDK completion: members come from the framework package, not from the host compiler.
  const completionText = source.replace("    Serial.println(sensor_value(1));", "    Serial.;");
  await service.change(session.id, file, completionText, 2);
  const completion = await service.request(session.id, file, 2, "completion", { line: valueLine, character: "    Serial.".length }) as CompletionItem[] | CompletionList;
  const items = Array.isArray(completion) ? completion : completion.items;
  assert.ok(items.some((item) => item.label === "println" || item.label === "begin"), "Arduino Serial members must come from the SDK: " + JSON.stringify(items.slice(0, 10)));

  // Diagnostics must react to real C++ errors while compiled with the ESP32-S3 flags.
  const beforeInvalid = service.get()!.diagnosticsReceived;
  await service.change(session.id, file, "#include <Arduino.h>\nvoid setup( { }\n", 3);
  await until(() => service.get()!.diagnosticsReceived > beforeInvalid && errors(3).length > 0, "expected a syntax error from clangd");
  const beforeRestore = service.get()!.diagnosticsReceived;
  await service.change(session.id, file, source, 4);
  await until(() => service.get()!.diagnosticsReceived > beforeRestore && document(4) !== undefined && errors(4).length === 0, "errors must clear after restoring valid code");

  // The same project with the explicit query-driver opt-in: only the exact Xtensa compiler from the selected environment.
  const authorized = await service.restart(session.id, { environment: "esp32-s3", queryDriver: true });
  assert.equal(authorized.compileDatabase, "ready");
  assert.ok(authorized.queryDrivers.length >= 1, "the selected environment's compiler must be resolved: " + JSON.stringify(authorized));
  for (const driver of authorized.queryDrivers) {
    assert.match(driver, /xtensa-esp32s3-elf-(g\+\+|gcc)(\.exe)?$/, driver);
    assert.match(driver.replaceAll("\\", "/"), /\.platformio\/packages\//, "only PlatformIO core packages are allowed: " + driver);
  }
  assert.ok(authorized.args.some((arg) => arg === "--query-driver=" + authorized.queryDrivers.join(",")));
  assert.equal(await fs.readFile(path.join(root, "script_runs.txt"), "utf8"), scriptRuns, "language restart must not rerun project scripts");
  await service.open(authorized.id, file, source, 1);
  const second = await service.request(authorized.id, file, 1, "hover", valuePosition) as Hover;
  assert.match(JSON.stringify(second.contents), /sensor_value/);

  // The cache is not self-certifying: a compiler that merely sits under a directory named .platformio is rejected.
  const fakeDirectory = path.join(root, "fake", ".platformio", "packages", "toolchain", "bin");
  await fs.mkdir(fakeDirectory, { recursive: true });
  const fakeCompiler = path.join(fakeDirectory, "xtensa-esp32s3-elf-g++");
  await fs.writeFile(fakeCompiler, "");
  const tampered = JSON.parse(recordText); tampered.metadata.drivers = [fakeCompiler];
  await fs.writeFile(recordPath, JSON.stringify(tampered));
  const rejectedCore = await service.restart(authorized.id, { environment: "esp32-s3", queryDriver: true });
  assert.deepEqual(rejectedCore.queryDrivers, [], "candidate paths cannot certify a PlatformIO core by their own ancestors");
  assert.match(rejectedCore.compileDatabaseMessage, /packages|query-driver/);
  tampered.metadata.drivers = [authorized.queryDrivers[0] + "*"];
  await fs.writeFile(recordPath, JSON.stringify(tampered));
  const rejectedGlob = await service.restart(rejectedCore.id, { environment: "esp32-s3", queryDriver: true });
  assert.deepEqual(rejectedGlob.queryDrivers, [], "glob characters are never forwarded to query-driver");
  await fs.writeFile(recordPath, recordText);
  const restored = await service.restart(rejectedGlob.id, { environment: "esp32-s3", queryDriver: true });
  assert.deepEqual(restored.queryDrivers, authorized.queryDrivers);
  assert.equal(await fs.readFile(path.join(root, "script_runs.txt"), "utf8"), scriptRuns, "reading the cache must not rerun project scripts");

  // Toolchain-only headers (newlib) need the compiler's system include paths, which query-driver supplies.
  const toolchainText = `#include <Arduino.h>
#include <stdio.h>
#include <string.h>
void setup() { Serial.begin(115200); }
void loop() { char text[16]; snprintf(text, sizeof text, "%d", (int)strlen("aether")); delay(1000); }
`;
  const toolchainLines = toolchainText.split("\n"); const strlenLine = toolchainLines.findIndex((item) => item.includes("strlen"));
  const beforeToolchain = service.get()!.diagnosticsReceived;
  await service.change(authorized.id, file, toolchainText, 2);
  const toolchainHover = await service.request(authorized.id, file, 2, "hover", { line: strlenLine, character: toolchainLines[strlenLine].indexOf("strlen") + 2 }) as Hover;
  assert.match(JSON.stringify(toolchainHover.contents), /strlen|size_t/i, "toolchain headers must resolve through query-driver");
  await until(() => service.get()!.diagnosticsReceived > beforeToolchain && document(2) !== undefined && errors(2).length === 0, "query-driver must keep ESP32 diagnostics clean");

  await service.close(authorized.id, file);
  await service.stop(authorized.id);
  console.log("PASS esp32: real ESP32-S3 PlatformIO compiledb pinned to env esp32-s3 with cached compiler metadata, Xtensa flags, clangd " + major + " Arduino/SDK completion, hover, project definition, live diagnostics, toolchain headers and explicit query-driver allow-list; no hardware");
} finally { await service.stop(); await tasks.stopAll(); await workspace.close(); await fs.rm(root, { recursive: true, force: true }); }
