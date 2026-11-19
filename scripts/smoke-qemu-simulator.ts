import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceService } from "../desktop/workspace";
import { TaskService } from "../desktop/tasks";
import { ToolService } from "../desktop/tools";
import { createPlatformioPlugins } from "../desktop/plugins/platformio";
import { createQemuSimulator, parsePartitionTable, qemuEsp32c3Tool, simulatorEvidence, type SimulatorSnapshot } from "../desktop/simulator/qemu";

// Real acceptance for the host-side simulator:
//   AETHER_QEMU_RISCV32=<Espressif qemu-system-riscv32.exe> \
//   AETHER_PLATFORMIO_CLI=<platformio.exe> \
//   node --import tsx scripts/smoke-qemu-simulator.ts
// It performs real PlatformIO builds, boots the real app bytes in QEMU, and reads the real UART0.
// The only temporary firmware is the explicitly labelled UART0 probe below; it is a separate app
// binary with its own SHA-256 and is never described as the production firmware.

const run = promisify(execFile);
const environment = "esp32-c3";
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base = await fs.mkdtemp(path.join(os.tmpdir(), "aether-qemu-smoke-"));
const log: string[] = [];
const note = (line: string) => { log.push(line); console.log(line); };

/** Windows recycle bin only: this is how the smoke test and the service dispose of private files. */
const recycle = async (target: string) => {
  if (process.platform !== "win32") throw new Error("此脚本只实现了 Windows 回收站清理，未删除：" + target);
  const escaped = target.replace(/'/g, "''");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('" + escaped + "','OnlyErrorDialogs','SendToRecycleBin')"],
  { windowsHide: true });
};

const until = async (condition: () => boolean, label: string, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await wait(100);
  }
  throw new Error("等待超时：" + label);
};

const processGone = (pid: number | null) => {
  assert.ok(typeof pid === "number" && pid > 0, "快照必须带真实进程号");
  assert.throws(() => process.kill(pid as number, 0), /ESRCH|not found|no such process/i, "QEMU 进程仍然存在：" + pid);
};

type Host = { workspace: WorkspaceService; tasks: TaskService; tools: ToolService };
const openProject = async (root: string): Promise<Host> => {
  const workspace = new WorkspaceService();
  const tasks = new TaskService(workspace);
  const tools = new ToolService(() => path.join(base, "tool-settings-" + path.basename(root) + ".json"));
  const platformio = createPlatformioPlugins(tools);
  tools.define(qemuEsp32c3Tool);
  tasks.register(platformio.platformioBuild);
  await workspace.open(root);
  return { workspace, tasks, tools };
};

const waitTask = async (tasks: TaskService, id: string, timeoutMs = 240000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = tasks.list().find((item) => item.id === id);
    if (!task) throw new Error("任务消失：" + id);
    if (task.status !== "running") return task;
    await wait(200);
  }
  throw new Error("PlatformIO 构建超时");
};

const build = async (root: string) => {
  const host = await openProject(root);
  const started = await host.tasks.start("platformio.build", { environment });
  const task = await waitTask(host.tasks, started.id);
  assert.equal(task.status, "succeeded", "真实 PlatformIO 构建失败：" + (task.error ?? "") + "\n" + task.log);
  const firmware = task.artifacts.find((item) => item.path.endsWith("/firmware.bin"));
  assert.ok(firmware, "构建记录必须包含 firmware.bin");
  note("[构建] " + root + " app " + firmware.sha256 + " (" + firmware.size + " bytes)");
  return host;
};

const recordOf = async (root: string) => JSON.parse(await fs.readFile(path.join(root, ".aether", "build.json"), "utf8")) as {
  environment: string; inputHash: string; artifacts: { path: string; sha256: string; size: number }[];
};

/** Independently reassembles the QEMU-only image from the recorded artifacts and compares SHAs. */
const expectedFlash = async (root: string) => {
  const record = await recordOf(root);
  const artifact = (name: string) => {
    const entry = record.artifacts.find((item) => path.posix.basename(item.path) === name);
    assert.ok(entry, "缺少构建产物 " + name);
    return entry;
  };
  const read = async (name: string) => fs.readFile(path.join(root, artifact(name).path));
  const bootloader = await read("bootloader.bin");
  const partitions = await read("partitions.bin");
  const app = await read("firmware.bin");
  const entries = parsePartitionTable(partitions);
  const appEntry = entries.find((item) => item.type === 0 && item.subtype === 0x10) ?? entries.find((item) => item.type === 0 && item.subtype === 0x00);
  assert.ok(appEntry, "分区表没有 app 分区");
  const end = Math.max(...entries.map((item) => item.offset + item.size));
  const size = [2, 4, 8, 16].map((mb) => mb * 1024 * 1024).find((candidate) => candidate >= end);
  assert.ok(size, "分区表超出 QEMU flash 容量");
  const image = Buffer.alloc(size, 0xff);
  bootloader.copy(image, 0x0);
  partitions.copy(image, 0x8000);
  app.copy(image, appEntry.offset);
  return { sha256: sha256(image), size, appSha256: sha256(app), appPath: artifact("firmware.bin").path, appOffset: appEntry.offset };
};

/** Stages source plus only the three recorded binaries; the acceptance does not copy whole build caches. */
const stageRecordedBuild = async (prod: string, target: string) => {
  await fs.cp(prodSource, target, { recursive: true, filter: (source) => !source.split(path.sep).includes(".pio") && !source.split(path.sep).includes(".aether") });
  await fs.mkdir(path.join(target, ".aether"), { recursive: true });
  await fs.copyFile(path.join(prod, ".aether", "build.json"), path.join(target, ".aether", "build.json"));
  const directory = path.join(target, ".pio", "build", environment);
  await fs.mkdir(directory, { recursive: true });
  for (const name of ["firmware.bin", "bootloader.bin", "partitions.bin"]) await fs.copyFile(path.join(prod, ".pio", "build", environment, name), path.join(directory, name));
};

const assertStopped = (snapshot: SimulatorSnapshot | null, reason: "cancel" | "timeout") => {  assert.ok(snapshot, "必须保留快照");
  assert.equal(snapshot.status, "stopped", snapshot.error ?? "模拟器未正常停止");
  assert.equal(snapshot.stopReason, reason);
  assert.ok(snapshot.log.length <= 250000 && snapshot.uart.length <= 250000 && snapshot.diagnostics.length <= 250000, "输出必须有界");
  processGone(snapshot.pid);
};

const assertQemuArgv = (snapshot: SimulatorSnapshot) => {
  assert.deepEqual(snapshot.argv.slice(0, 4), ["-display", "none", "-serial", "stdio"]);
  assert.equal(snapshot.argv[4], "-monitor");
  assert.equal(snapshot.argv[5], "none");
  assert.equal(snapshot.argv[6], "-machine");
  assert.equal(snapshot.argv[7], "esp32c3");
  assert.match(snapshot.argv[8] ?? "", /^-drive$/);
  assert.match(snapshot.argv[9] ?? "", /^file=.*,if=mtd,format=raw$/);
  assert.equal(snapshot.argv.length, 10, "模拟器 argv 固定，不能追加任意参数");
};

const prodSource = path.resolve("examples/platformio-esp32c3");
const probeSource = path.join(base, "uart-probe-source");
const hosts: Host[] = [];
const simulators: ReturnType<typeof createQemuSimulator>[] = [];
try {
  for (const key of ["AETHER_QEMU_RISCV32", "AETHER_PLATFORMIO_CLI"]) {
    assert.ok(process.env[key]?.trim(), "必须显式设置 " + key + "（真实工具路径），本脚本不使用替身");
  }
  await run(process.env.AETHER_PLATFORMIO_CLI as string, ["--version"], { timeout: 15000, windowsHide: true });
  const version = await run(process.env.AETHER_QEMU_RISCV32 as string, ["--version"], { timeout: 15000, windowsHide: true });
  note("[QEMU] " + version.stdout.trim().split(/\r?\n/)[0]);

  // Production example project: copied so the repository keeps no build cache.
  const prod = path.join(base, "prod");
  await fs.cp(prodSource, prod, { recursive: true, filter: (source) => !source.split(path.sep).includes(".pio") && !source.split(path.sep).includes(".aether") });
  const prodHost = await build(prod); hosts.push(prodHost);
  const prodSimulator = createQemuSimulator({ tools: prodHost.tools, workspace: prodHost.workspace, trashItem: recycle });
  simulators.push(prodSimulator);
  const prodExpected = await expectedFlash(prod);

  // 1) The production app bytes really boot: ROM/bootloader UART0 lines, app payload identical.
  await prodSimulator.start({ environment, timeoutMs: 8000 });
  await until(() => prodSimulator.snapshot()?.uart.includes("ESP-ROM:esp32c3") ?? false, "生产固件 UART0 ROM 输出", 12000);
  await until(() => prodSimulator.snapshot()?.uart.includes("entry 0x") ?? false, "生产固件进入 app", 8000);
  await prodSimulator.cancel();
  const prodRun = prodSimulator.snapshot();
  assertStopped(prodRun, "cancel");
  assertQemuArgv(prodRun!);
  assert.equal(prodRun!.app.sha256, prodExpected.appSha256, "QEMU 使用的 app 必须与构建记录逐字节一致");
  assert.equal(prodRun!.app.size, (await fs.stat(path.join(prod, prodExpected.appPath))).size);
  assert.equal(prodRun!.flash.sha256, prodExpected.sha256, "独立重算的 QEMU flash SHA 必须一致");
  assert.equal(prodRun!.flash.size, prodExpected.size);
  assert.equal(prodRun!.flash.partitions.find((item) => item.type === 0 && item.subtype === 0x10)?.offset, prodExpected.appOffset);
  const record = await recordOf(prod);
  assert.equal(prodRun!.build.inputHash, record.inputHash);
  assert.equal(prodRun!.build.recordSha256, sha256(await fs.readFile(path.join(prod, ".aether", "build.json"))));
  // The example prints over native USB CDC; QEMU exposes UART0 only, so the app line is honestly absent.
  assert.ok(!prodRun!.uart.includes("Aether ESP32-C3 firmware"), "生产示例的 USB CDC 行不应从 UART0 出现");
  // Cross-end evidence contract: hard fields are passed/appSha256/environment; QEMU identity stays in source.
  const evidence = simulatorEvidence(prodRun!);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.passed, true, "真实 ROM 输出与干净停止才允许 passed=true");
  assert.match(evidence.appSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.appSha256, prodRun!.app.sha256);
  assert.equal(evidence.environment, record.environment);
  assert.equal(evidence.inputHash, record.inputHash, "inputHash 必须是 WorkspaceService.fingerprint 的同一算法");
  assert.ok(!Number.isNaN(Date.parse(evidence.recordedAt)), "recordedAt 必须是 ISO 时间");
  assert.equal(evidence.source.qemuVersion, prodRun!.qemu.version);
  assert.equal(evidence.source.buildRecordSha256, prodRun!.build.recordSha256);
  assert.equal(evidence.source.qemuFlashSha256, prodRun!.flash.sha256);
  assert.notEqual(evidence.appSha256, evidence.source.qemuFlashSha256, "app SHA 与 QEMU flash SHA 不能混用");
  note("[通过] 证据记录：passed=" + evidence.passed + "，appSha256=" + evidence.appSha256 + "，environment=" + evidence.environment);
  note("[通过] 生产示例启动：app " + prodRun!.app.sha256 + "，UART0 行 " + prodRun!.uart.trim().split(/\r?\n/).slice(-2).join(" / "));

  // 2) A separate UART0 probe proves the app-level UART path; its binary and SHA differ from prod.
  await fs.mkdir(path.join(probeSource, "src"), { recursive: true });
  await fs.writeFile(path.join(probeSource, "platformio.ini"), [
    "; 验收探针，不是生产固件：ESP32-C3 Arduino，Serial 走 UART0 (GPIO20/21)。",
    "[env:esp32-c3]", "platform = espressif32@6.12.0", "board = esp32-c3-devkitm-1", "framework = arduino", "monitor_speed = 115200", "",
  ].join("\n"));
  await fs.writeFile(path.join(probeSource, "src", "main.cpp"), [
    "#include <Arduino.h>",
    "void setup() { Serial.begin(115200); delay(300); }",
    "void loop() { Serial.println(\"AETHER-QEMU-UART-PROBE\"); delay(1000); }", "",
  ].join("\n"));
  const probe = path.join(base, "probe");
  await fs.cp(probeSource, probe, { recursive: true });
  const probeHost = await build(probe); hosts.push(probeHost);
  const probeSimulator = createQemuSimulator({ tools: probeHost.tools, workspace: probeHost.workspace, trashItem: recycle });
  simulators.push(probeSimulator);
  const probeExpected = await expectedFlash(probe);
  assert.notEqual(probeExpected.appSha256, prodExpected.appSha256, "探针与生产应用必须是不同的固件");

  await probeSimulator.start({ environment, timeoutMs: 8000 });
  await until(() => probeSimulator.snapshot()?.uart.includes("AETHER-QEMU-UART-PROBE") ?? false, "UART0 探针输出", 12000);
  await probeSimulator.cancel();
  const probeRun = probeSimulator.snapshot();
  assertStopped(probeRun, "cancel");
  assert.equal(probeRun!.app.sha256, probeExpected.appSha256);
  note("[通过] UART0 探针：app " + probeRun!.app.sha256 + "，UART 行 AETHER-QEMU-UART-PROBE");

  // 2b) 16MB layout probe matching the physical device table family: app at 0x100000, ota_1 at 0x700000.
  //     QEMU still boots ota_0 from its erased private otadata; the app payload stays byte-identical.
  const layoutSource = path.join(base, "layout-probe-source");
  await fs.mkdir(path.join(layoutSource, "src"), { recursive: true });
  await fs.writeFile(path.join(layoutSource, "partitions.csv"), [
    "# Name,   Type, SubType, Offset,   Size,     Flags",
    "nvs,      data, nvs,     0x9000,   0x4000,",
    "otadata,  data, ota,     0xD000,   0x2000,",
    "phy_init, data, phy,     0xF000,   0x1000,",
    "model,    data, spiffs,  0x10000,  0xF0000,",
    "ota_0,    app,  ota_0,   0x100000, 0x600000,",
    "ota_1,    app,  ota_1,   0x700000, 0x600000,", "",
  ].join("\n"));
  await fs.writeFile(path.join(layoutSource, "platformio.ini"), [
    "; 16MB 布局探针：仅验证宿主模块对物理设备分区表族的处理，不是生产固件。",
    "[env:esp32-c3]", "platform = espressif32@6.12.0", "board = esp32-c3-devkitm-1", "framework = arduino", "monitor_speed = 115200",
    "board_build.partitions = partitions.csv", "board_upload.flash_size = 16MB", "board_upload.maximum_size = 6291456", "",
  ].join("\n"));
  await fs.writeFile(path.join(layoutSource, "src", "main.cpp"), [
    "#include <Arduino.h>",
    "void setup() { Serial.begin(115200); delay(300); }",
    "void loop() { Serial.println(\"AETHER-QEMU-LAYOUT-16MB\"); delay(1000); }", "",
  ].join("\n"));
  const layout = path.join(base, "layout");
  await fs.cp(layoutSource, layout, { recursive: true });
  const layoutHost = await build(layout); hosts.push(layoutHost);
  const layoutSimulator = createQemuSimulator({ tools: layoutHost.tools, workspace: layoutHost.workspace, trashItem: recycle });
  simulators.push(layoutSimulator);
  const layoutExpected = await expectedFlash(layout);
  assert.equal(layoutExpected.size, 16 * 1024 * 1024, "16MB 分区表必须生成 16MB 私有 flash");
  assert.equal(layoutExpected.appOffset, 0x100000, "app 偏移必须来自 partitions.bin 的 ota_0");
  await layoutSimulator.start({ environment, timeoutMs: 8000 });
  await until(() => layoutSimulator.snapshot()?.uart.includes("AETHER-QEMU-LAYOUT-16MB") ?? false, "16MB 布局 UART", 12000);
  await layoutSimulator.cancel();
  const layoutRun = layoutSimulator.snapshot();
  assertStopped(layoutRun, "cancel");
  assert.equal(layoutRun!.flash.size, 16 * 1024 * 1024);
  assert.equal(layoutRun!.flash.partitions.find((item) => item.subtype === 0x11)?.offset, 0x700000, "分区表必须保留物理 ota_1 槽");
  assert.equal(layoutRun!.app.sha256, layoutExpected.appSha256);
  assert.equal(simulatorEvidence(layoutRun!).passed, true);
  note("[通过] 16MB 物理同族布局：app @0x100000，ota_1 @0x700000 保留，QEMU 从 ota_0 启动，app " + layoutRun!.app.sha256);

  // 3) Timeout really stops the process and cleans private files.
  await probeSimulator.start({ environment, timeoutMs: 1500 });
  await until(() => probeSimulator.snapshot()?.status !== "running", "超时停止", 12000);
  assertStopped(probeSimulator.snapshot(), "timeout");
  note("[通过] 超时停止并收束真实进程");

  // 4) Cancel immediately after an explicit start.
  await probeSimulator.start({ environment, timeoutMs: 30000 });
  await probeSimulator.cancel();
  assertStopped(probeSimulator.snapshot(), "cancel");

  // 5) A tampered build record is refused before any process exists.
  const tampered = path.join(base, "tampered-record");
  await stageRecordedBuild(prod, tampered);
  const tamperedRecordPath = path.join(tampered, ".aether", "build.json");
  const tamperedRecord = JSON.parse(await fs.readFile(tamperedRecordPath, "utf8"));
  // The copy is a real move of the same build: point the record at its own root, then tamper one SHA.
  tamperedRecord.root = tampered;
  const tamperedFirmware = tamperedRecord.artifacts.find((item: { path: string }) => item.path.endsWith("/firmware.bin"));
  tamperedFirmware.sha256 = "0".repeat(64);
  await fs.writeFile(tamperedRecordPath, JSON.stringify(tamperedRecord, null, 2));
  const tamperedHost = await openProject(tampered); hosts.push(tamperedHost);
  const tamperedSimulator = createQemuSimulator({ tools: tamperedHost.tools, workspace: tamperedHost.workspace, trashItem: recycle });
  simulators.push(tamperedSimulator);
  await assert.rejects(() => tamperedSimulator.start({ environment, timeoutMs: 5000 }), /与构建记录不一致|SHA-256/, "被篡改的构建记录必须被拒绝");
  assert.equal(tamperedSimulator.snapshot()?.status, "failed");
  assert.equal(tamperedSimulator.snapshot()?.pid, null);
  note("[通过] 篡改构建产物 SHA 被拒绝，未启动进程");

  // 6) Changed project input after the build is refused before any process exists.
  const changed = path.join(base, "changed-input");
  await stageRecordedBuild(prod, changed);
  const changedRecordPath = path.join(changed, ".aether", "build.json");
  const changedRecord = JSON.parse(await fs.readFile(changedRecordPath, "utf8"));
  changedRecord.root = changed;
  await fs.writeFile(changedRecordPath, JSON.stringify(changedRecord, null, 2));
  await fs.appendFile(path.join(changed, "src", "main.cpp"), "\n// changed after the recorded build\n");
  const changedHost = await openProject(changed); hosts.push(changedHost);
  const changedSimulator = createQemuSimulator({ tools: changedHost.tools, workspace: changedHost.workspace, trashItem: recycle });
  simulators.push(changedSimulator);
  await assert.rejects(() => changedSimulator.start({ environment, timeoutMs: 5000 }), /工程输入与构建记录不一致/, "输入变化必须被拒绝");
  assert.equal(changedSimulator.snapshot()?.status, "failed");
  note("[通过] 构建后修改源码被拒绝，未启动进程");

  // 7) A missing tool reports a real spawn/locate error, not a fabricated run.
  const missingRoot = path.join(base, "missing-tool");
  await fs.cp(prodSource, missingRoot, { recursive: true, filter: (source) => !source.split(path.sep).includes(".pio") && !source.split(path.sep).includes(".aether") });
  const missingHost = await openProject(missingRoot); hosts.push(missingHost);
  await missingHost.tools.setPath("qemu-esp32c3", path.join(base, "missing-qemu-system-riscv32.exe"));
  const missingSimulator = createQemuSimulator({ tools: missingHost.tools, workspace: missingHost.workspace, trashItem: recycle });
  simulators.push(missingSimulator);
  await assert.rejects(() => missingSimulator.start({ environment, timeoutMs: 5000 }), /找不到可执行文件|无法启动/, "缺失工具必须真实报错");
  assert.equal(missingSimulator.snapshot()?.status, "failed");
  note("[通过] 缺失 QEMU 路径返回真实错误");

  // 8) One slot: a second start while running is refused.
  await probeSimulator.start({ environment, timeoutMs: 30000 });
  await assert.rejects(() => probeSimulator.start({ environment, timeoutMs: 5000 }), /已在运行/);
  await probeSimulator.dispose();
  assertStopped(probeSimulator.snapshot(), "cancel");

  note("[汇总] 真实 QEMU 版本：" + version.stdout.trim().split(/\r?\n/)[0]);
  note("[汇总] 生产 app SHA-256：" + prodRun!.app.sha256 + "；QEMU flash SHA-256：" + prodRun!.flash.sha256);
  note("[汇总] 探针 app SHA-256：" + probeRun!.app.sha256);
  note("[未实测] 非 Windows 平台、USB Serial/JTAG 模拟、B 分支真实工程（本脚本用同族 16MB 布局探针验证了 0x100000/0x700000 的处理）。");
  console.log("PASS qemu simulator: real PlatformIO builds, real QEMU boots, verified app bytes, UART0, timeout/cancel, refusal paths; no hardware serial");
} finally {
  for (const item of simulators) await item.dispose().catch(() => {});
  for (const host of hosts) { await host.tasks.stopAll().catch(() => {}); await host.workspace.close().catch(() => {}); }
  await recycle(base).catch((error) => console.error("回收站清理失败，保留 " + base + "：" + String(error)));
}
