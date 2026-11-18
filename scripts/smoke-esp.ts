import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  checkUploadAgainstPlan, chipIdFromMcu, classifyUsb, evaluatePreflight, parseEfuseSummary, parseFlashId,
  parseImageHeader, parsePartitionTable, parseUploadCommand, samePartitionTable, type EspPartitionEntry, type EspPreflightInput,
} from "../shared/esp";
import { WorkspaceService } from "../desktop/workspace";
import { ToolService } from "../desktop/tools";
import { ESPTOOL_TOOL } from "../desktop/esp/esptool";
import { preflightEspUpload } from "../desktop/esp/preflight";

// ---------------------------------------------------------------------------------------------
// Fixtures: real esptool 4.9 output captured from COM4 (ESP32-C3, 16MB) and synthetic binaries.
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
  allow: {},
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
assert.equal(flash.macReported, true, "the MAC may be detected but its value is never returned");
assert.ok(!JSON.stringify(flash).includes("00:00:00:00:00:00"), "the MAC value must not leak into the parsed result");
assert.equal(parseFlashId("no output").chip, null);

assert.equal(chipIdFromMcu("esp32c3"), 5);
assert.equal(chipIdFromMcu("esp32s3"), 9);
assert.equal(chipIdFromMcu("esp32"), 0);
assert.equal(chipIdFromMcu("atmega328p"), null);
assert.equal(classifyUsb({ vendorId: "303a", productId: "1001", manufacturer: "Espressif", product: "" }).kind, "native-usb");
assert.equal(classifyUsb({ vendorId: "10c4", productId: "ea60", manufacturer: "Silicon Labs", product: "" }).kind, "usb-uart-bridge");
assert.equal(classifyUsb(null).kind, "unknown");

const header = parseImageHeader(image(5)).header;
assert.equal(header?.chipId, 5);
assert.equal(parseImageHeader(Buffer.from([1, 2, 3])).header, null);
assert.match(parseImageHeader(Buffer.alloc(24)).error, /0xE9/);

const table = parsePartitionTable(partitionTable([
  partition("nvs", 1, 2, 0x9000, 0x4000), partition("otadata", 1, 0, 0xe000, 0x2000),
  partition("app0", 0, 0x10, 0x10000, 0x100000),
]));
assert.equal(table.valid, true);
assert.equal(table.entries.length, 3);
assert.equal(table.entries[2].offset, 0x10000);
assert.match(parsePartitionTable(Buffer.alloc(0x1000, 0xff)).error, /空白 flash/);
{
  const unaligned = Buffer.alloc(32);
  unaligned.writeUInt16LE(0x50aa, 0); unaligned[2] = 0; unaligned.writeUInt32LE(0x1008, 4); unaligned.writeUInt32LE(0x1000, 8);
  unaligned.write("app", 12, "ascii");
  assert.match(parsePartitionTable(unaligned).error, /不是 4KB 对齐/, "unaligned offsets are rejected");
}

const efuse = parseEfuseSummary("SECURE_BOOT_EN (BLOCK0) = False\nSPI_BOOT_CRYPT_CNT (BLOCK0) = Disable\nDIS_DOWNLOAD_MODE (BLOCK0) = False");
assert.deepEqual({ ...efuse, source: "" }, { secureBoot: false, flashEncryption: false, downloadModeDisabled: false, source: "" });
assert.equal(parseEfuseSummary("SECURE_BOOT_EN = True").secureBoot, true);

// --- preflight rules ---------------------------------------------------------------------------
// A healthy layout: app inside ota_0, boot_app0 absent, identical table.
const healthyTable = [partition("nvs", 1, 2, 0x9000, 0x4000), partition("app0", 0, 0x10, 0x100000, 0x600000)];
{
  const input = baseInput();
  input.images.partitions.entries = healthyTable;
  input.device.partitions = { entries: healthyTable, valid: true, error: "" };
  assert.deepEqual(blocks(input), [], "a matching ESP32-C3 plan must pass: " + JSON.stringify(ids(input)));
  assert.equal(evaluatePreflight(input).ok, true);
  assert.deepEqual(evaluatePreflight(input).segments.map((segment) => segment.offset), [0, 0x8000, 0x100000]);
}

// C3/S3 mismatch: the build targets C3 but the port reports an S3.
{
  const input = baseInput();
  input.chip.detectedId = 9; input.chip.detectedName = "ESP32-S3";
  assert.ok(blocks(input).includes("chip-mismatch"));
  assert.equal(evaluatePreflight(input).ok, false);
}

// 0x10000 model overlap: the board default writes the app over a data partition.
{
  const input = baseInput();
  const deviceTable = [partition("model", 1, 0x82, 0x10000, 0xf0000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)];
  input.images.partitions.entries = deviceTable;
  input.device.partitions = { entries: deviceTable, valid: true, error: "" };
  input.layout.appOffset = 0x10000;
  assert.ok(blocks(input).includes("app-outside-table"), JSON.stringify(ids(input)));
  const finding = evaluatePreflight(input).findings.find((item) => item.id === "app-outside-table")!;
  assert.match(finding.detail, /model/, "the blocked partition must be named");
}

// 0xe000 crossing otadata/phy_init: blocked until the user acknowledges it explicitly.
{
  const input = baseInput();
  const deviceTable = [partition("otadata", 1, 0, 0xd000, 0x2000), partition("phy_init", 1, 1, 0xf000, 0x1000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)];
  input.images.partitions.entries = deviceTable;
  input.device.partitions = { entries: deviceTable, valid: true, error: "" };
  input.images.bootApp0 = { file: "boot_app0.bin", size: 0x2000, sha256: "dd" };
  assert.ok(blocks(input).includes("bootapp0-overlap"));
  input.allow.bootApp0Overwrite = true;
  assert.ok(!blocks(input).includes("bootapp0-overlap"), "the acknowledgement is the documented handling path");
  assert.ok(ids(input).includes("bootapp0-overlap-allowed"));
}

// A changed partition table is blocked unless explicitly acknowledged.
{
  const input = baseInput();
  const deviceTable = [partition("nvs", 1, 2, 0x9000, 0x4000), partition("ota_0", 0, 0x10, 0x100000, 0x600000)];
  input.images.partitions.entries = [...deviceTable, partition("storage", 1, 0x82, 0x700000, 0x100000)];
  input.device.partitions = { entries: deviceTable, valid: true, error: "" };
  assert.ok(blocks(input).includes("partition-rewrite"));
  input.allow.partitionRewrite = true;
  assert.ok(!blocks(input).includes("partition-rewrite"));
  assert.equal(samePartitionTable(deviceTable, deviceTable), true);
}

// Unverifiable uploads and bad artifacts never pass.
{
  const input = baseInput(); input.upload = { protocol: "espota", parseable: false, reason: "espota" };
  assert.ok(blocks(input).includes("upload-unverifiable"));
}
{
  const input = baseInput(); input.chip.expectedId = 9; input.chip.expectedMcu = "esp32s3";
  assert.ok(blocks(input).includes("artifact-chip-mismatch"), "a stale C3 build under an S3 target is rejected");
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

// --- post-upload evidence ----------------------------------------------------------------------
const log = `esptool.py v4.9.0
esptool.py --chip esp32c3 --port "COM4" --baud 460800 write_flash -z --flash_mode dio --flash_size 16MB 0x0 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x100000 firmware.bin
Writing at 0x00010000... (100 %)
Hash of data verified.
Hash of data verified.
Hash of data verified.
Hash of data verified.`;
const evidence = parseUploadCommand(log);
assert.equal(evidence.parseable, true);
assert.deepEqual(evidence.writes.map((write) => write.offset), [0, 0x8000, 0xe000, 0x100000]);
assert.equal(evidence.verifiedHashes, 4);
const plan = [
  { offset: 0, file: "bootloader.bin" }, { offset: 0x8000, file: "partitions.bin" },
  { offset: 0xe000, file: "boot_app0.bin" }, { offset: 0x100000, file: "firmware.bin" },
];
assert.equal(checkUploadAgainstPlan(log, plan).ok, true);
const drifted = checkUploadAgainstPlan(log, plan.filter((item) => item.offset !== 0x100000));
assert.equal(drifted.ok, false);
assert.ok(drifted.problems.some((problem) => problem.includes("多出")), JSON.stringify(drifted.problems));
assert.equal(parseUploadCommand("no esptool here").parseable, false);

// ---------------------------------------------------------------------------------------------
// Integration: the real preflight path (real PlatformIO metadata + a recording fake esptool).
// ---------------------------------------------------------------------------------------------
const pio = process.env.AETHER_PLATFORMIO_CLI?.trim() || "platformio";
const pioAvailable = await promisify(execFile)(pio, ["--version"], { timeout: 15000 }).then(() => true, () => false);
if (!pioAvailable) {
  console.log("PASS esp: pure parsing/preflight rules only (PlatformIO not available, integration skipped)");
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-smoke-"));
  const logFile = path.join(root, "esptool-calls.jsonl");
  const fake = path.join(root, "esptool.py");
  const deviceTable = path.join(root, "device-partitions.bin");
  const workspace = new WorkspaceService();
  const tools = new ToolService(() => path.join(root, "tools.json"));
  tools.define(ESPTOOL_TOOL);
  const env = { ...process.env, AETHER_ESPTOOL: fake, AETHER_FAKE_LOG: logFile, AETHER_FAKE_PARTITIONS: deviceTable };
  const savedEnv = { AETHER_ESPTOOL: process.env.AETHER_ESPTOOL, AETHER_FAKE_LOG: process.env.AETHER_FAKE_LOG, AETHER_FAKE_CHIP: process.env.AETHER_FAKE_CHIP, AETHER_FAKE_PARTITIONS: process.env.AETHER_FAKE_PARTITIONS };
  const restoreEnv = () => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  Object.assign(process.env, env);

  const calls = async () => {
    const text = await fs.readFile(logFile, "utf8").catch(() => "");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
  };
  const writeCommands = async () => (await calls()).filter((args) => args.some((arg) => /write_flash|erase_flash|erase_region|write_mem/.test(arg)));

  // The fake records every invocation and only ever prints read-only output.
  await fs.writeFile(fake, `import json, os, sys
args = sys.argv[1:]
with open(os.environ["AETHER_FAKE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if "version" in args:
    print("esptool.py v4.9.0"); print("4.9.0"); sys.exit(0)
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
if "summary" in args:
    print("SECURE_BOOT_EN (BLOCK0) = False"); print("SPI_BOOT_CRYPT_ALGO (BLOCK0) = 0 R/W")
    print("SPI_BOOT_CRYPT_CNT (BLOCK0) = Disable"); print("DIS_DOWNLOAD_MODE (BLOCK0) = False"); sys.exit(0)
if any(item in args for item in ("write_flash", "erase_flash", "erase_region")):
    sys.stdout.write("REFUSED: the smoke test must never write flash\\n"); sys.exit(9)
sys.exit(0)
`, "utf8");

  const project = async (ini: string, buildTable: Buffer, device: Buffer) => {
    await workspace.close().catch(() => {});
    await fs.rm(path.join(root, ".pio"), { recursive: true, force: true }).catch(() => {});
    await fs.writeFile(deviceTable, device);
    await fs.rm(path.join(root, ".aether"), { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(root, ".pio", "build", "esp32-c3"), { recursive: true });
    await fs.writeFile(path.join(root, "platformio.ini"), ini);
    const firmware = image(5, 0x400);
    await fs.writeFile(path.join(root, ".pio", "build", "esp32-c3", "firmware.bin"), firmware);
    await fs.writeFile(path.join(root, ".pio", "build", "esp32-c3", "bootloader.bin"), image(5, 0x100));
    await fs.writeFile(path.join(root, ".pio", "build", "esp32-c3", "partitions.bin"), buildTable);
    // boot_app0.bin normally ships with the Arduino framework; a local copy keeps the fixture independent.
    await fs.writeFile(path.join(root, ".pio", "build", "esp32-c3", "boot_app0.bin"), Buffer.alloc(0x2000));
    await workspace.open(root);
    const inputHash = await workspace.fingerprint();
    await fs.mkdir(path.join(root, ".aether"), { recursive: true });
    const artifacts = [];
    for (const name of ["firmware.bin", "bootloader.bin", "partitions.bin"]) {
      const bytes = await fs.readFile(path.join(root, ".pio", "build", "esp32-c3", name));
      artifacts.push({ path: ".pio/build/esp32-c3/" + name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    }
    await fs.writeFile(path.join(root, ".aether", "build.json"), JSON.stringify({ environment: "esp32-c3", inputHash, artifacts, status: "succeeded" }));
    return inputHash;
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
    // 1. A matching plan passes and the device is only read.
    await project(iniSafe, safeTable, safeTable);
    const safe = await preflightEspUpload({ root, environment: "esp32-c3", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.equal(safe.supported, true);
    assert.equal(safe.ok, true, JSON.stringify(safe.findings));
    assert.deepEqual(safe.segments.map((segment) => segment.offset), [0, 0x8000, 0xe000, 0x100000]);
    assert.deepEqual(await writeCommands(), [], "a read-only preflight must not contain any write command");

    // 2. Danger: the default 0x10000 app offset lands on the vendor `model` data partition.
    await project(iniDefaultOffset, vendorTable, vendorTable);
    const dangerous = await preflightEspUpload({ root, environment: "esp32-c3", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.equal(dangerous.ok, false);
    assert.ok(dangerous.findings.some((finding) => finding.id === "app-outside-table"), JSON.stringify(dangerous.findings.map((finding) => finding.id)));
    assert.deepEqual(await writeCommands(), [], "a blocked plan must not contain any write command");

    // 3. boot_app0 across the vendor layout needs the explicit acknowledgement.
    await project(iniSafe, vendorTable, vendorTable);
    const crossing = await preflightEspUpload({ root, environment: "esp32-c3", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.ok(crossing.findings.some((finding) => finding.id === "bootapp0-overlap"), JSON.stringify(crossing.findings.map((finding) => finding.id)));
    const acknowledged = await preflightEspUpload({ root, environment: "esp32-c3", port: "COM_TEST", platformio: pio, workspace, tools, allow: { bootApp0Overwrite: true } });
    assert.ok(!acknowledged.findings.some((finding) => finding.id === "bootapp0-overlap" && finding.severity === "block"));

    // 4. Chip mismatch: an S3 device with a C3 build is blocked before anything is written.
    process.env.AETHER_FAKE_CHIP = "esp32s3";
    const mismatch = await preflightEspUpload({ root, environment: "esp32-c3", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.ok(mismatch.findings.some((finding) => finding.id === "chip-mismatch"));
    process.env.AETHER_FAKE_CHIP = "esp32c3";
    assert.deepEqual(await writeCommands(), [], "no scenario may write flash");

    // 5. A non-ESP project is skipped entirely and the port is never touched.
    const before = (await calls()).length;
    await fs.writeFile(path.join(root, "platformio.ini"), "[env:native]\nplatform = native@1.2.1\n");
    const native = await preflightEspUpload({ root, environment: "native", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.equal(native.supported, false);
    assert.equal(native.ok, true);
    assert.equal((await calls()).length, before, "a non-ESP project must not open the port or run esptool");

    // 6. A custom upload script cannot be verified and is refused on the ESP path.
    await project(iniSafe + "extra_scripts = pre:custom.py\n", safeTable, safeTable);
    const custom = await preflightEspUpload({ root, environment: "esp32-c3", port: "COM_TEST", platformio: pio, workspace, tools });
    assert.ok(custom.findings.some((finding) => finding.id === "upload-unverifiable"));

    const total = (await calls()).length;
    assert.deepEqual(await writeCommands(), [], "zero write commands across every scenario (" + total + " esptool calls)");
    console.log("PASS esp: image/partition/flash_id parsing, 9 blocking rules (C3/S3 mismatch, 0x10000 model overlap, 0xe000 crossing, partition rewrite, alignment, flash size, secure boot, unverifiable upload, unreadable device), post-upload write-plan evidence, and a real preflight against real PlatformIO metadata with a recording esptool — " + total + " read-only calls, zero writes; non-ESP projects untouched");
  } finally {
    await workspace.close();
    restoreEnv();
    await fs.rm(root, { recursive: true, force: true });
  }
}
