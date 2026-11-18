import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  checkUploadAgainstPlan, chipIdFromMcu, classifyUsb, evaluatePreflight, parseFlashId,
  parseImageHeader, parsePartitionTable, parseSecurityInfo, parseUploadCommand, samePartitionTable,
  type EspPartitionEntry, type EspPreflightInput,
} from "../shared/esp";
import { WorkspaceService } from "../desktop/workspace";
import { TaskService } from "../desktop/tasks";
import { ToolService } from "../desktop/tools";
import { ESPTOOL_TOOL, runEsptool } from "../desktop/esp/esptool";
import { writeRanges, createEspUploadProvider } from "../desktop/esp/upload";
import { preflightEspUpload } from "../desktop/esp/preflight";
import { createPlatformioPlugins } from "../desktop/plugins/platformio";

// ---------------------------------------------------------------------------------------------
// Fixtures: real esptool 4.9 / get_security_info output captured from COM4 (ESP32-C3, 16MB).
// ---------------------------------------------------------------------------------------------
const REAL_FLASH_ID = `esptool.py v4.9.0
Serial port COM4
Connecting...
Detecting chip type... ESP32-C3
Chip is ESP32-C3 (QFN32) (revision v0.4)
Features: WiFi, BLE
Crystal is 40MHz
USB mode: USB-Serial/JTAG
MAC: 00:00:00:00:00:00
Uploading stub...
Running stub...
Stub running...
Manufacturer: ef
Device: 4018
Detected flash size: 16MB
Hard resetting via RTS pin...`;
const REAL_SECURITY = `Security Information:
=====================
Flags: 0x00000000 (0b0)
Chip ID: 5
API Version: 3
Secure Boot: Disabled
Flash Encryption: Disabled
SPI Boot Crypt Count (SPI_BOOT_CRYPT_CNT): 0x0
Hard resetting via RTS pin...`;

const image = (chipId: number, payload = 64) => {
  const bytes = Buffer.alloc(24 + payload);
  bytes[0] = 0xe9; bytes[1] = 1; bytes[2] = 0x02; bytes[3] = 0x20; bytes[23] = 0x01;
  bytes.writeUInt32LE(0x10000, 4); bytes.writeUInt16LE(chipId, 12);
  return bytes;
};
const partition = (label: string, type: number, subtype: number, offset: number, size: number): EspPartitionEntry => ({
  label, type, subtype, typeName: type === 0 ? "app" : "data", subtypeName: type === 0 ? "ota_0" : subtype === 2 ? "nvs" : "spiffs", offset, size, flags: 0,
});
const partitionTable = (entries: EspPartitionEntry[]) => {
  const bytes = Buffer.alloc(0x1000, 0xff);
  entries.forEach((entry, index) => {
    const at = index * 32;
    // Real flash stores AA 50; a little-endian uint16 read of those bytes is 0x50AA.
    bytes.writeUInt16LE(0x50aa, at); bytes[at + 2] = entry.type; bytes[at + 3] = entry.subtype;
    bytes.writeUInt32LE(entry.offset, at + 4); bytes.writeUInt32LE(entry.size, at + 8);
    bytes.write(entry.label, at + 12, 16, "ascii");
  });
  bytes.writeUInt16LE(0xebeb, entries.length * 32);
  return bytes;
};

const baseInput = (): EspPreflightInput => ({
  port: "COM4", environment: "esp32-c3",
  chip: { expectedId: 5, expectedMcu: "esp32c3", expectedSource: "board", detectedId: 5, detectedName: "ESP32-C3", detectedRevision: "v0.4" },
  flash: { declared: 16 * 1024 * 1024, declaredSource: "board", detected: 16 * 1024 * 1024 },
  images: {
    app: { file: "firmware.bin", size: 0x30000, sha256: "aa", chipId: 5, valid: true, error: "" },
    bootloader: { file: "bootloader.bin", size: 0x4000, sha256: "bb", chipId: 5, valid: true },
    partitions: { file: "partitions.bin", size: 0xc00, sha256: "cc", entries: [], valid: true, error: "" },
    bootApp0: null, missing: [],
  },
  layout: { appOffset: 0x100000, appOffsetSource: "test", bootloaderOffset: 0, partitionOffset: 0x8000, bootApp0Offset: 0xe000 },
  device: { ok: true, error: "", partitions: null, security: null },
  upload: { protocol: "esptool", parseable: true, reason: "" },
});
const ids = (input: EspPreflightInput) => evaluatePreflight(input).findings.map((finding) => finding.id);
const blocks = (input: EspPreflightInput) => evaluatePreflight(input).findings.filter((finding) => finding.severity === "block").map((finding) => finding.id);

// --- pure parsing -----------------------------------------------------------------------------
const flash = parseFlashId(REAL_FLASH_ID);
assert.equal(flash.chip?.key, "esp32c3");
assert.equal(flash.chip?.revision, "v0.4");
assert.deepEqual(flash.chip?.features, ["WiFi", "BLE"]);
assert.equal(flash.chip?.crystalMhz, 40);
assert.equal(flash.flash?.size, 16 * 1024 * 1024);
assert.equal(flash.flash?.manufacturer, "ef");
assert.equal(flash.flash?.device, "4018");
assert.equal(flash.macReported, true);
assert.ok(!JSON.stringify(flash).includes("00:00:00:00:00:00"), "the MAC value must not leak into the parsed result");
assert.equal(parseFlashId("no output").chip, null);

const security = parseSecurityInfo(REAL_SECURITY);
assert.equal(security.secureBoot, false);
assert.equal(security.flashEncryption, false);
assert.equal(parseSecurityInfo("Secure Boot: Enabled").secureBoot, true);
assert.equal(parseSecurityInfo("Flash Encryption: Enabled").flashEncryption, true);
assert.equal(parseSecurityInfo("").secureBoot, null);

assert.equal(chipIdFromMcu("esp32c3"), 5);
assert.equal(chipIdFromMcu("esp32s3"), 9);
assert.equal(chipIdFromMcu("atmega328p"), null);
assert.equal(classifyUsb({ vendorId: "303a", productId: "1001", manufacturer: "Espressif", product: "" }).kind, "native-usb");
assert.equal(classifyUsb({ vendorId: "10c4", productId: "ea60", manufacturer: "Silicon Labs", product: "" }).kind, "usb-uart-bridge");
assert.equal(classifyUsb(null).kind, "unknown");

const header = parseImageHeader(image(5)).header;
assert.equal(header?.chipId, 5);
assert.equal(parseImageHeader(Buffer.from([1, 2, 3])).header, null);
assert.match(parseImageHeader(Buffer.alloc(24)).error, /0xE9/);

const table = parsePartitionTable(partitionTable([partition("nvs", 1, 2, 0x9000, 0x4000), partition("otadata", 1, 0, 0xe000, 0x2000), partition("app0", 0, 0x10, 0x10000, 0x100000)]));
assert.equal(table.valid, true);
assert.equal(table.entries.length, 3);
assert.match(parsePartitionTable(Buffer.alloc(0x1000, 0xff)).error, /空白 flash/);
{
  const unaligned = Buffer.alloc(32);
  unaligned.writeUInt16LE(0x50aa, 0); unaligned.writeUInt32LE(0x1008, 4); unaligned.writeUInt32LE(0x1000, 8);
  unaligned.write("app", 12, "ascii");
  assert.match(parsePartitionTable(unaligned).error, /不是 4KB 对齐/);
}

// --- preflight rules ---------------------------------------------------------------------------
const healthyTable = [partition("nvs", 1, 2, 0x9000, 0x4000), partition("app0", 0, 0x10, 0x100000, 0x600000)];
{
  const input = baseInput();
  input.images.partitions.entries = healthyTable;
  input.device.partitions = { entries: healthyTable, valid: true, error: "" };
  assert.deepEqual(blocks(input), [], "a matching ESP32-C3 plan must pass: " + JSON.stringify(ids(input)));
  assert.deepEqual(evaluatePreflight(input).segments.map((segment) => segment.offset), [0, 0x8000, 0x100000]);
}
{
  const input = baseInput();
  input.chip.detectedId = 9; input.chip.detectedName = "ESP32-S3";
  assert.ok(blocks(input).includes("chip-mismatch"));
}
// The vendor layout: a stock 4MB build writes its app at 0x10000, which the device uses for `model`.
{
  const input = baseInput();
  const deviceTable = [partition("model", 1, 0x82, 0x10000, 0xf0000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)];
  input.images.partitions.entries = deviceTable;
  input.device.partitions = { entries: deviceTable, valid: true, error: "" };
  input.layout.appOffset = 0x10000;
  assert.ok(blocks(input).includes("app-outside-table"), JSON.stringify(ids(input)));
}
// A build whose own table calls 0x10000 an app partition still must not overwrite device data.
{
  const input = baseInput();
  const buildTable = [partition("app0", 0, 0x10, 0x10000, 0x140000)];
  const deviceTable = [partition("model", 1, 0x82, 0x10000, 0xf0000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)];
  input.images.partitions.entries = buildTable;
  input.device.partitions = { entries: deviceTable, valid: true, error: "" };
  input.layout.appOffset = 0x10000;
  assert.ok(blocks(input).includes("app-over-device-data"), JSON.stringify(ids(input)));
  assert.match(evaluatePreflight(input).findings.find((item) => item.id === "app-over-device-data")!.detail, /model/);
}
// boot_app0 across otadata/phy_init: reported with the exact device ranges, covered by the journal.
{
  const input = baseInput();
  const deviceTable = [partition("otadata", 1, 0, 0xd000, 0x2000), partition("phy_init", 1, 1, 0xf000, 0x1000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)];
  input.images.partitions.entries = deviceTable;
  input.device.partitions = { entries: deviceTable, valid: true, error: "" };
  input.images.bootApp0 = { file: "boot_app0.bin", size: 0x2000, sha256: "dd" };
  const result = evaluatePreflight(input);
  assert.ok(result.findings.some((finding) => finding.id === "bootapp0-overlap" && finding.severity === "warn"));
  assert.ok(result.coverage.some((entry) => entry.label === "phy_init" && entry.range.offset === 0xf000 && entry.range.size === 0x1000), JSON.stringify(result.coverage));
  input.device.security = { secureBoot: false, flashEncryption: false, downloadModeDisabled: false, source: "test" };
  assert.equal(evaluatePreflight(input).ok, true, "a verified security state completes the plan");
}
{
  const input = baseInput();
  input.upload = { protocol: "espota", parseable: false, reason: "espota" };
  assert.ok(blocks(input).includes("upload-unverifiable"));
}
{
  const input = baseInput(); input.chip.expectedId = 9; input.chip.expectedMcu = "esp32s3";
  assert.ok(blocks(input).includes("artifact-chip-mismatch"));
}
{
  const input = baseInput(); input.flash.declared = 32 * 1024 * 1024;
  assert.ok(blocks(input).includes("flash-too-small"));
}
{
  const input = baseInput(); input.device.security = { secureBoot: true, flashEncryption: false, downloadModeDisabled: false, source: "test" };
  assert.ok(blocks(input).includes("secure-boot"));
}
{
  const input = baseInput(); input.device.ok = false; input.device.error = "端口被占用";
  assert.ok(blocks(input).includes("device-unreadable"));
}
{
  const input = baseInput(); input.layout.appOffset = 0x100800;
  assert.ok(blocks(input).includes("unaligned"));
}
assert.ok(samePartitionTable(healthyTable, healthyTable));
assert.deepEqual(writeRanges([{ offset: 0, size: 0x4000 }, { offset: 0x8000, size: 0xc00 }, { offset: 0x100000, size: 0x400 }]), [{ offset: 0, size: 0x4000 }, { offset: 0x8000, size: 0x1000 }, { offset: 0x100000, size: 0x1000 }]);

// --- post-upload evidence ----------------------------------------------------------------------
const log = `esptool.py v4.9.0
esptool.py --chip esp32c3 --port "COM4" --baud 460800 write_flash -z --flash_mode dio --flash_size 16MB 0x0 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x100000 firmware.bin
Hash of data verified.
Hash of data verified.
Hash of data verified.
Hash of data verified.`;
const evidence = parseUploadCommand(log);
assert.deepEqual(evidence.writes.map((write) => write.offset), [0, 0x8000, 0xe000, 0x100000]);
const plan = [{ offset: 0, file: "bootloader.bin" }, { offset: 0x8000, file: "partitions.bin" }, { offset: 0xe000, file: "boot_app0.bin" }, { offset: 0x100000, file: "firmware.bin" }];
assert.equal(checkUploadAgainstPlan(log, plan).ok, true);
assert.equal(checkUploadAgainstPlan(log, plan.filter((item) => item.offset !== 0x100000)).ok, false);
{
  // A private snapshot path may contain spaces; quoted arguments must stay a single write entry.
  const spaced = 'esptool write_flash 0x0 "C:\\Users\\Jane Doe\\bootloader.bin" 0x8000 "C:\\Users\\Jane Doe\\partitions.bin"';
  assert.deepEqual(parseUploadCommand(spaced).writes.map((write) => write.file.split(/[\\/]/).pop()), ["bootloader.bin", "partitions.bin"]);
}

// ---------------------------------------------------------------------------------------------
// Provider: the authoritative path. Real PlatformIO metadata + recording fake esptool.
// ---------------------------------------------------------------------------------------------
const pio = process.env.AETHER_PLATFORMIO_CLI?.trim() || "platformio";
const pioAvailable = await promisify(execFile)(pio, ["--version"], { timeout: 15000 }).then(() => true, () => false);
if (!pioAvailable) {
  console.log("PASS esp: pure parsing/preflight rules only (PlatformIO not available, integration skipped)");
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-smoke-"));
  // The fake tool and its call log live outside the project: anything inside would change its fingerprint.
  const toolsDir = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-fake-"));
  const logFile = path.join(toolsDir, "esptool-calls.jsonl");
  const fake = path.join(toolsDir, "esptool.py");
  const deviceTableFile = path.join(toolsDir, "device-partitions.bin");
  // The journal must live outside the project: writing it inside would change the build fingerprint.
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-journals-"));
  // Private input snapshots are injected so the test can prove they are removed, and captured writes prove their bytes.
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-inputs-"));
  const capture = path.join(toolsDir, "capture");
  const workspace = new WorkspaceService();
  const tasks = new TaskService(workspace);
  const tools = new ToolService(() => path.join(root, "tools.json"));
  tools.define(ESPTOOL_TOOL);
  // createPlatformioPlugins also registers the platformio tool identity the ESP provider resolves.
  const platformio = createPlatformioPlugins(tools);
  tasks.register(platformio.platformioUpload);
  const upload = createEspUploadProvider(tools, workspace, { journalRoot: () => journalRoot, snapshotRoot: () => snapshotRoot });
  tasks.register(upload);
  const savedEnv = { AETHER_ESPTOOL: process.env.AETHER_ESPTOOL, AETHER_FAKE_LOG: process.env.AETHER_FAKE_LOG, AETHER_FAKE_CHIP: process.env.AETHER_FAKE_CHIP, AETHER_FAKE_PARTITIONS: process.env.AETHER_FAKE_PARTITIONS, AETHER_FAKE_CAPTURE: process.env.AETHER_FAKE_CAPTURE, AETHER_FAKE_TAMPER_ON: process.env.AETHER_FAKE_TAMPER_ON, AETHER_FAKE_TAMPER_FILE: process.env.AETHER_FAKE_TAMPER_FILE };
  const restoreEnv = () => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  Object.assign(process.env, { AETHER_ESPTOOL: fake, AETHER_FAKE_LOG: logFile, AETHER_FAKE_PARTITIONS: deviceTableFile });

  const calls = async () => (await fs.readFile(logFile, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const writes = async () => (await calls()).filter((args) => args.some((arg) => /write_flash|erase_flash|erase_region|write_mem/.test(arg)));

  // The fake records every invocation. Reads are served from fixtures; writes only report verified hashes.
  await fs.writeFile(fake, `import json, os, sys
args = sys.argv[1:]
with open(os.environ["AETHER_FAKE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
tamper_on = os.environ.get("AETHER_FAKE_TAMPER_ON", "")
if tamper_on and tamper_on in args and os.environ.get("AETHER_FAKE_TAMPER_FILE"):
    with open(os.environ["AETHER_FAKE_TAMPER_FILE"], "wb") as target:
        target.write(b"TAMPERED-WORKSPACE")
if "version" in args:
    print("esptool.py v4.9.0"); print("4.9.0"); sys.exit(0)
if "get_security_info" in args:
    print("Secure Boot: Disabled"); print("Flash Encryption: Disabled"); print("SPI_BOOT_CRYPT_CNT: 0x0"); sys.exit(0)
if "flash_id" in args:
    chip = os.environ.get("AETHER_FAKE_CHIP", "esp32c3")
    name = {"esp32c3": "ESP32-C3", "esp32s3": "ESP32-S3", "esp32": "ESP32"}.get(chip, "ESP32-C3")
    print("Chip is %s (QFN32) (revision v0.4)" % name)
    print("Features: WiFi, BLE"); print("Crystal is 40MHz"); print("Detected flash size: 16MB")
    print("Manufacturer: ef"); print("Device: 4018"); sys.exit(0)
if "read_flash" in args:
    target = args[args.index("read_flash") + 3]
    with open(target, "wb") as out:
        out.write(open(os.environ["AETHER_FAKE_PARTITIONS"], "rb").read())
    sys.exit(0)
if any(item in args for item in ("write_flash", "erase_flash", "erase_region", "write_mem")):
    capture = os.environ.get("AETHER_FAKE_CAPTURE")
    if capture:
        import hashlib, re, shutil
        os.makedirs(capture, exist_ok=True)
        manifest = []
        index = args.index("write_flash") + 1
        while index < len(args):
            token = args[index]
            if re.match(r"^0x[0-9a-fA-F]+$", token) and index + 1 < len(args) and not args[index + 1].startswith("-"):
                source = args[index + 1]
                destination = os.path.join(capture, token + "-" + os.path.basename(source))
                shutil.copyfile(source, destination)
                with open(destination, "rb") as handle:
                    digest = hashlib.sha256(handle.read()).hexdigest()
                manifest.append({"offset": int(token, 16), "name": os.path.basename(source), "size": os.path.getsize(destination), "sha256": digest})
                index += 2
            else:
                index += 1
        with open(os.path.join(capture, "manifest.json"), "w") as handle:
            json.dump(manifest, handle)
    print("Hash of data verified."); print("Hash of data verified."); print("Hash of data verified."); print("Hash of data verified.")
    sys.exit(0)
sys.exit(0)
`, "utf8");

  const project = async (ini: string, buildTable: Buffer, device: Buffer) => {
    await workspace.close().catch(() => {});
    await fs.rm(path.join(root, ".pio"), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(root, ".aether"), { recursive: true, force: true }).catch(() => {});
    await fs.writeFile(deviceTableFile, device.subarray(0, Math.min(device.length, 0x1000)));
    await fs.mkdir(path.join(root, ".pio", "build", "esp32-c3"), { recursive: true });
    await fs.writeFile(path.join(root, "platformio.ini"), ini);
    const artifacts = [];
    for (const [name, bytes] of [["firmware.bin", image(5, 0x400)], ["bootloader.bin", image(5, 0x100)], ["partitions.bin", buildTable]] as const) {
      const file = path.join(root, ".pio", "build", "esp32-c3", name);
      await fs.writeFile(file, bytes);
      artifacts.push({ path: ".pio/build/esp32-c3/" + name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await fs.writeFile(path.join(root, ".pio", "build", "esp32-c3", "boot_app0.bin"), Buffer.alloc(0x2000));
    await workspace.open(root);
    const inputHash = await workspace.fingerprint();
    await fs.mkdir(path.join(root, ".aether"), { recursive: true });
    await fs.writeFile(path.join(root, ".aether", "build.json"), JSON.stringify({ environment: "esp32-c3", inputHash, artifacts, status: "succeeded" }));
  };
  const waitTask = async (id: string) => {
    for (let n = 0; n < 1200; n++) { const task = tasks.list().find((item) => item.id === id)!; if (task.status !== "running") return task; await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error("task timeout");
  };

  const iniSafe = `[env:esp32-c3]
platform = espressif32@6.12.0
board = esp32-c3-devkitm-1
framework = arduino
board_upload.offset_address = 0x100000
`;
  const iniDefaultOffset = iniSafe.replace("board_upload.offset_address = 0x100000\n", "");
  const safeTable = partitionTable([partition("nvs", 1, 2, 0x9000, 0x4000), partition("otadata", 1, 0, 0xe000, 0x2000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)]);
  const vendorTable = partitionTable([partition("nvs", 1, 2, 0x9000, 0x4000), partition("otadata", 1, 0, 0xd000, 0x2000), partition("phy_init", 1, 1, 0xf000, 0x1000), partition("model", 1, 0x82, 0x10000, 0xf0000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)]);
  try {
    // 1. A matching plan passes; the device is read, the sectors are journaled, then esptool writes.
    await project(iniSafe, safeTable, safeTable);
    const safe = await waitTask((await tasks.start("esp.upload", { port: "COM_TEST", environment: "esp32-c3" })).id);
    assert.equal(safe.status, "succeeded", safe.error);
    const journal = (safe.metadata as { journal?: { ranges: unknown[]; directory: string } } | undefined)?.journal;
    assert.ok(journal && journal.ranges.length >= 3, "the write journal must be recorded: " + JSON.stringify(safe.metadata));
    assert.ok(journal!.directory.startsWith(journalRoot));
    const writeCheck = (safe.metadata as { writeCheck?: { ok: boolean } } | undefined)?.writeCheck;
    assert.ok(writeCheck, "the write command is compared with the verified plan");
    assert.equal((await writes()).length, 1, "exactly one verified write command");
    const safeInputs = (safe.metadata as { inputSnapshot?: { directory: string; files: Array<{ name: string }> } } | undefined)?.inputSnapshot;
    assert.ok(safeInputs && safeInputs.files.some((file) => file.name === "boot_app0.bin"), "boot_app0 is part of the private write snapshot");
    assert.equal(await fs.stat(safeInputs!.directory).then(() => true, () => false), false, "the private input snapshot is removed after the task");
    assert.deepEqual(await fs.readdir(snapshotRoot), [], "no private input directory is left behind");

    // 1b. The verified bytes, not the workspace file, are what esptool writes. Replace firmware.bin after
    //     prepare(); the captured write must still contain the original image and boot_app0.
    await fs.writeFile(logFile, "");
    await project(iniSafe, safeTable, safeTable);
    const originalFirmware = await fs.readFile(path.join(root, ".pio", "build", "esp32-c3", "firmware.bin"));
    const snapshotPrepared = await upload.prepare!(root, pio, { port: "COM_TEST", environment: "esp32-c3" }, new AbortController().signal, () => {});
    const preparedMeta = snapshotPrepared.metadata as { espPreflight: { segments: Array<{ name: string; file: string }> }; inputSnapshot: { directory: string; files: Array<{ name: string; file: string; sha256: string }> } };
    assert.ok(preparedMeta.inputSnapshot.files.some((file) => file.name === "boot_app0.bin"), "boot_app0 is snapshotted");
    const segmentFiles = snapshotPrepared.args.filter((arg) => /\.bin$/i.test(arg));
    assert.equal(segmentFiles.length, preparedMeta.espPreflight.segments.length, "every planned segment is written from a snapshot path");
    assert.ok(segmentFiles.every((file) => path.dirname(file) === preparedMeta.inputSnapshot.directory), "esptool is pointed only at the private directory");
    await fs.writeFile(path.join(root, ".pio", "build", "esp32-c3", "firmware.bin"), Buffer.from("TAMPERED AFTER PREPARE"));
    await fs.rm(capture, { recursive: true, force: true });
    process.env.AETHER_FAKE_CAPTURE = capture;
    try {
      const run = await runEsptool({ executable: snapshotPrepared.executable!, prefix: [] }, snapshotPrepared.args, { timeoutMs: 60000 });
      assert.equal(run.code, 0, run.output);
      const manifest = JSON.parse(await fs.readFile(path.join(capture, "manifest.json"), "utf8")) as Array<{ name: string; sha256: string; size: number }>;
      const written = manifest.find((entry) => entry.name === "firmware.bin");
      assert.equal(written?.sha256, createHash("sha256").update(originalFirmware).digest("hex"), "the flashed firmware is the verified snapshot, not the replaced workspace file");
      assert.equal(manifest.some((entry) => entry.name === "boot_app0.bin"), true, "boot_app0 is written from the snapshot too");
    } finally {
      delete process.env.AETHER_FAKE_CAPTURE;
      await upload.afterRun!();
    }
    assert.equal(await fs.stat(preparedMeta.inputSnapshot.directory).then(() => true, () => false), false, "afterRun removes the private input snapshot");
    assert.deepEqual(await fs.readdir(snapshotRoot), [], "the injected snapshot root is empty after the write");

    // 1c. A workspace change that lands between the preflight read and the copy is refused, and the
    //     half-built private snapshot is removed without issuing a write command.
    await fs.writeFile(logFile, "");
    await project(iniSafe, safeTable, safeTable);
    process.env.AETHER_FAKE_TAMPER_ON = "flash_id";
    process.env.AETHER_FAKE_TAMPER_FILE = path.join(root, ".pio", "build", "esp32-c3", "firmware.bin");
    try {
      await assert.rejects(() => upload.prepare!(root, pio, { port: "COM_TEST", environment: "esp32-c3" }, new AbortController().signal, () => {}), /写前输入快照与预检不一致/);
    } finally {
      delete process.env.AETHER_FAKE_TAMPER_ON;
      delete process.env.AETHER_FAKE_TAMPER_FILE;
    }
    assert.deepEqual(await fs.readdir(snapshotRoot), [], "a refused snapshot leaves no private directory");
    assert.deepEqual(await writes(), [], "a refused snapshot never reaches write_flash");

    // 2. Chip mismatch: the provider refuses before spawning anything.
    await fs.writeFile(logFile, "");
    process.env.AETHER_FAKE_CHIP = "esp32s3";
    await project(iniSafe, safeTable, safeTable);
    await assert.rejects(() => tasks.start("esp.upload", { port: "COM_TEST", environment: "esp32-c3" }), /芯片与构建目标不匹配|部署前核对未通过/);
    assert.deepEqual(await writes(), [], "a chip mismatch must produce zero write commands");
    process.env.AETHER_FAKE_CHIP = "esp32c3";

    // 3. The app would land on the device's `model` data partition: refused with zero writes.
    await fs.writeFile(logFile, "");
    await project(iniDefaultOffset, vendorTable, vendorTable);
    await assert.rejects(() => tasks.start("esp.upload", { port: "COM_TEST", environment: "esp32-c3" }), /app 会覆盖设备上的数据分区 model|部署前核对未通过/);
    assert.deepEqual(await writes(), [], "a destructive app placement must produce zero write commands");

    // 4. boot_app0 across the vendor layout is allowed only with a verified journal, never by a flag.
    await fs.writeFile(logFile, "");
    await project(iniSafe, vendorTable, vendorTable);
    const crossing = await waitTask((await tasks.start("esp.upload", { port: "COM_TEST", environment: "esp32-c3" })).id);
    assert.equal(crossing.status, "succeeded", crossing.error);
    const crossingJournal = (crossing.metadata as { journal?: { ranges: Array<{ offset: number }> } } | undefined)?.journal;
    assert.ok(crossingJournal?.ranges.some((range) => range.offset === 0xe000), "the boot_app0 sector is journaled");

    // 5. A non-ESP project is untouched: platformio.upload keeps its behaviour and never touches the port.
    await fs.writeFile(logFile, "");
    await fs.writeFile(path.join(root, "platformio.ini"), "[env:native]\nplatform = native@1.2.1\n");
    const platformio = createPlatformioPlugins(tools);
    const prepared = await platformio.platformioUpload.prepare!(root, pio, { port: "COM_TEST", environment: "native" }, new AbortController().signal, () => {});
    assert.deepEqual(prepared.args, ["run", "-e", "native", "--target", "upload", "--upload-port", "COM_TEST"]);
    const native = await preflightEspUpload({ root, environment: "native", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.equal(native.supported, false);
    assert.equal((await calls()).length, 0, "a non-ESP project must not touch the port");

    // 6. ESP uploads through platformio.upload are refused at the provider entry.
    await project(iniSafe, safeTable, safeTable);
    await assert.rejects(() => platformio.platformioUpload.prepare!(root, pio, { port: "COM_TEST", environment: "esp32-c3" }, new AbortController().signal, () => {}), /esp\.upload/);

    // Step 5 cleared the log; nothing after it may reach the device, and step 6 refused before spawning.
    assert.deepEqual(await writes(), [], "no write may happen after the verified plan");
    console.log("PASS esp: parsing, security (get_security_info), 10 blocking rules (C3/S3 mismatch, 0x10000 model overlap via app-outside-table and app-over-device-data, unaligned, flash size, secure boot, unreadable device, unverifiable upload, build-record binding), write-plan evidence, and the authoritative esp.upload provider against real PlatformIO metadata: chip mismatch and destructive placement refused with zero write commands, valid plans journal every erased 4KB sector before writing, a private snapshot (including boot_app0) is what esptool writes even when the workspace firmware is replaced after prepare, a changed snapshot is refused and cleaned up, non-ESP untouched");
  } finally {
    await tasks.stopAll().catch(() => {});
    await workspace.close();
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(toolsDir, { recursive: true, force: true });
    await fs.rm(journalRoot, { recursive: true, force: true });
    await fs.rm(snapshotRoot, { recursive: true, force: true });
  }
}
