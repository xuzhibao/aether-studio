import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliEsptool, FlashService, diffRanges, parseFlashId, parseSecurity } from "../desktop/flash";
import type { FlashBackupOptions, FlashRestorePrepareOptions } from "../shared/flash";

// Drives the real esptool CLI argument surface against a file-backed fake "device".
// No serial port is opened and no real board is touched. Temporary data is left in %TEMP% for inspection.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-flash-"));
const fixture = path.resolve("scripts/fixtures/fake-esptool.mjs");
const esptool = new CliEsptool({ executable: process.execPath, prefixArgs: [fixture] });
const workspace = path.join(root, "project");
await fs.mkdir(workspace, { recursive: true });
const OUT = path.join(root, "out");
const CACHE = path.join(root, "cache");
const PORT = "COM-TEST";
const CHUNK = 64 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hex = (n: number) => "0x" + n.toString(16);

function clearEnv() {
  for (const key of Object.keys(process.env)) if (key.startsWith("AETHER_FAKE_")) delete process.env[key];
}
let seq = 0;
interface Scenario { name: string; image: string; state: string; log: string; work: string; bytes: Buffer }
async function scenario(name: string, size = 1024 * 1024): Promise<Scenario> {
  clearEnv();
  const work = path.join(root, `case-${++seq}-${name}`);
  await fs.mkdir(work, { recursive: true });
  const image = path.join(work, "flash.bin");
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) & 0xff;
  bytes[0] = 0xe9; bytes[1] = 0x00; bytes[2] = 0x00; bytes[3] = 0x00;
  bytes[0x8000] = 0xaa; bytes[0x8001] = 0x50;
  await fs.writeFile(image, bytes);
  const state = path.join(work, "state.json");
  const log = path.join(work, "calls.log");
  process.env.AETHER_FAKE_IMAGE = image;
  process.env.AETHER_FAKE_STATE = state;
  process.env.AETHER_FAKE_LOG = log;
  process.env.AETHER_FAKE_FLASH = size % (1024 * 1024) === 0 ? `${size / (1024 * 1024)}MB` : `${Math.round(size / 1024)}KB`;
  return { name, image, state, log, work, bytes };
}
function service() {
  return new FlashService(esptool, { cacheRoot: CACHE, workspaceRoot: () => workspace });
}
async function calls(s: Scenario) {
  try { return (await fs.readFile(s.log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
async function waitFor<T>(check: () => Promise<T | undefined | false>, label: string, timeout = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("timeout waiting for " + label);
    await sleep(25);
  }
}
const backupOptions = (s: Scenario, name: string, overrides: Partial<FlashBackupOptions> = {}): FlashBackupOptions => ({
  port: PORT, outputPath: path.join(OUT, `${s.name}-${name}.bin`), chunkSize: CHUNK, baudRate: 230400, retries: 2, ...overrides,
});
const restoreOptions = (s: Scenario, backupPath: string, overrides: Partial<FlashRestorePrepareOptions> = {}): FlashRestorePrepareOptions => ({
  port: PORT, backupPath, chunkSize: CHUNK, baudRate: 230400, retries: 2, ...overrides,
});
const exists = (file: string) => fs.access(file).then(() => true, () => false);

// ---- pure parsers ----
const realFlashId = `esptool.py v4.9.0\nSerial port COM4\nConnecting....\nDetecting chip type... ESP32-C3\nChip is ESP32-C3 (QFN32) (revision v0.4)\nFeatures: WiFi, BLE\nCrystal is 40MHz\nMAC: 60:55:f9:00:11:22\nManufacturer: 0xef\nDevice: 0x4018\nDetected flash size: 16MB\nHard resetting via RTS pin...`;
const parsed = parseFlashId(realFlashId);
assert.equal(parsed.chip, "ESP32-C3");
assert.equal(parsed.flashSizeBytes, 16 * 1024 * 1024);
assert.equal(parsed.flashManufacturerId, "0xef");
assert.equal(parsed.flashDeviceId, "0x4018");
assert.equal(parsed.mac, "60:55:f9:00:11:22");
assert.deepEqual(parsed.features, ["WiFi", "BLE"]);
assert.throws(() => parseFlashId("Chip is ESP32-C3\n"), /无法.*识别|Flash 大小/);
assert.deepEqual(parseSecurity("Secure Boot: Disabled\nFlash Encryption: Disabled\n"), { checked: true, secureBootEnabled: false, flashEncryptionEnabled: false, note: "已用 esptool get_security_info 只读确认。" });
assert.equal(parseSecurity("Secure Boot: Enabled\nFlash Encryption: Disabled\n").secureBootEnabled, true);
assert.equal(parseSecurity("something else").checked, false);
assert.deepEqual(diffRanges(Buffer.from([1, 1, 2, 2, 3, 3, 4, 4]), Buffer.from([1, 9, 2, 9, 3, 3, 4, 4]), 2), [{ offset: 0, size: 4 }]);

// ---- backup: chunked read with one corrupt chunk and a lower-baud retry ----
{
  const s = await scenario("retry");
  process.env.AETHER_FAKE_READ_FAIL_OFFSETS = String(0x10000);
  process.env.AETHER_FAKE_READ_FAIL_TIMES = "1";
  const flash = service();
  const options = backupOptions(s, "retry");
  const result = await flash.startBackup(options);
  assert.equal(result.metadata.fileLength, s.bytes.length);
  assert.equal(result.metadata.sha256, sha(s.bytes));
  assert.ok(result.retriesUsed >= 1, "a failed chunk must be retried");
  assert.deepEqual(result.metadata.sanity, { bootloaderMagic: true, partitionMagic: true });
  assert.equal(await fs.readFile(options.outputPath).then(sha), sha(s.bytes));
  const reads = (await calls(s)).filter((call) => call.command === "read_flash" && call.args.includes("0x10000"));
  assert.equal(reads.length, 2, "the failing chunk is read twice");
  assert.equal(reads[0].baud, 230400);
  assert.equal(reads[1].baud, 115200, "the retry steps the baud rate down");
  await assert.rejects(flash.startBackup(options), /已存在|不会覆盖/);
  console.log("PASS flash: chunk retry + digest + no overwrite");
}

// ---- backup: exhausted retries leave no success file and report the offset ----
{
  const s = await scenario("fail");
  process.env.AETHER_FAKE_READ_FAIL_OFFSETS = String(0x20000);
  process.env.AETHER_FAKE_READ_FAIL_TIMES = "999";
  const flash = service();
  const options = backupOptions(s, "fail", { retries: 1 });
  await assert.rejects(flash.startBackup(options), /偏移 0x20000/);
  assert.equal(await exists(options.outputPath), false, "no final backup file after failure");
  assert.equal(await exists(options.outputPath + ".meta.json"), false);
  assert.equal(flash.snapshot().progress?.failedOffset, 0x20000);
  const leftovers = await fs.readdir(s.work).catch(() => [] as string[]);
  assert.ok(!leftovers.some((name) => name.endsWith(".bin") && name !== "flash.bin"), "no partial image appears next to the device");
  console.log("PASS flash: failed backup has no success file and names the offset");
}

// ---- backup: cancellation leaves no success file ----
{
  const s = await scenario("cancel-backup");
  process.env.AETHER_FAKE_DELAY_MS = "300";
  const flash = service();
  const options = backupOptions(s, "cancel");
  const running = flash.startBackup(options);
  await sleep(200);
  await flash.cancel();
  await assert.rejects(running, (error: Error) => error.name === "AbortError");
  assert.equal(await exists(options.outputPath), false);
  assert.match(flash.snapshot().error, /取消.*未生成/);
  console.log("PASS flash: cancelled backup produces no success file");
}

// ---- restore: header preserved, only differing ranges written, read back verified ----
{
  const s = await scenario("restore");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "restore"));
  const original = await fs.readFile(s.image);
  // Simulate a later flash: change the bootloader header area and one app block.
  const changed = Buffer.from(original);
  for (let index = 0x10; index < 0x20; index++) changed[index] = 0x55;
  for (let index = 0x40000; index < 0x40020; index++) changed[index] = 0x66;
  await fs.writeFile(s.image, changed);

  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.blocked, "");
  assert.ok(plan.ranges.some((range) => range.offset === 0), "a changed bootloader header is part of the plan");
  assert.ok(plan.ranges.some((range) => range.offset === 0x40000));
  assert.ok(plan.ranges.every((range) => range.offset % 4096 === 0));

  await assert.rejects(flash.executeRestore(plan.planId, "wrong"), /确认文字不匹配/);
  assert.equal(sha(await fs.readFile(s.image)), sha(changed), "a wrong confirmation writes nothing");

  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "completed", result.message);
  assert.equal(result.readBackVerified, true);
  assert.ok(result.writtenRanges.every((range) => range.verified));
  assert.deepEqual(await fs.readFile(s.image), original, "restore reproduces the backup byte for byte, including the header");
  const writes = (await calls(s)).filter((call) => call.command === "write_flash");
  assert.ok(writes.length > 0);
  for (const write of writes) {
    assert.ok(!write.args.some((arg: string) => /^--flash_(mode|freq|size)$/.test(arg)), "write_flash never receives flash parameters: " + write.args.join(" "));
    assert.ok(!write.args.includes("--erase-all") && !write.args.includes("-e"), "restore never erases the whole chip");
  }
  assert.ok(!(await calls(s)).some((call) => call.rewrittenHeader), "the fixture must not have rewritten the bootloader header");
  console.log("PASS flash: restore keeps the header, writes only differences, verifies read-back");
}

// ---- restore: no differences means no writes ----
{
  const s = await scenario("noop");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "noop"));
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.blocked, "");
  assert.deepEqual(plan.ranges, []);
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "completed");
  assert.equal(result.writtenRanges.length, 0);
  assert.equal((await calls(s)).filter((call) => call.command === "write_flash").length, 0);
  console.log("PASS flash: identical device is reported without writing");
}

// ---- restore: read-back mismatch is a failure, never a completion ----
{
  const s = await scenario("verify-fail");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "verify"));
  const changed = Buffer.from(await fs.readFile(s.image));
  for (let index = 0x20000; index < 0x20020; index++) changed[index] = 0x77;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.ok(plan.ranges.length > 0);
  process.env.AETHER_FAKE_WRITE_MANGLE = "1";
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "failed");
  assert.match(result.message, /读回校验失败/);
  assert.equal(result.readBackVerified, false);
  assert.ok(result.writtenRanges.some((range) => !range.verified));
  assert.ok(result.remainingRanges.length > 0, "failed ranges stay listed as unfinished");
  console.log("PASS flash: read-back mismatch reports failure with unfinished ranges");
}

// ---- restore: protected device is refused ----
{
  const s = await scenario("secure");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "secure"));
  const changed = Buffer.from(await fs.readFile(s.image));
  changed[0x30000] ^= 0xff;
  await fs.writeFile(s.image, changed);
  process.env.AETHER_FAKE_SECURE = "1";
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.match(plan.blocked, /安全启动|Flash 加密/);
  assert.deepEqual(plan.ranges, []);
  assert.equal((await calls(s)).filter((call) => call.command === "write_flash").length, 0);
  await assert.rejects(flash.executeRestore(plan.planId, plan.confirmationPhrase), /拒绝/);
  console.log("PASS flash: secure-boot device refuses restore");
}

// ---- restore: device mismatch and digest mismatch are refused ----
{
  const s = await scenario("mismatch");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "match"));
  process.env.AETHER_FAKE_MAC = "60:55:f9:99:88:77";
  const wrongDevice = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.match(wrongDevice.blocked, /不匹配/);
  delete process.env.AETHER_FAKE_MAC;

  const tampered = path.join(OUT, "tampered.bin");
  const bytes = await fs.readFile(backup.outputPath);
  bytes[0x50000] ^= 0xff;
  await fs.writeFile(tampered, bytes);
  await fs.copyFile(backup.outputPath + ".meta.json", tampered + ".meta.json");
  const wrongDigest = await flash.prepareRestore(restoreOptions(s, tampered));
  assert.match(wrongDigest.blocked, /SHA-256/);
  console.log("PASS flash: device and digest mismatches are refused");
}

// ---- restore: esptool without write support is refused explicitly ----
{
  const s = await scenario("no-write");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "no-write"));
  process.env.AETHER_FAKE_NO_WRITE = "1";
  const limited = service();
  const caps = await limited.capabilities();
  assert.equal(caps.writeFlash, false);
  const plan = await limited.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.match(plan.blocked, /不支持 write_flash/);
  console.log("PASS flash: unsupported write capability is refused");
}

// ---- restore: cancellation reports written ranges and never claims completion ----
{
  const s = await scenario("cancel-restore");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "cancel-restore"));
  const changed = Buffer.from(await fs.readFile(s.image));
  for (let index = 0x10000; index < 0x10020; index++) changed[index] = 0x11;
  for (let index = 0x70000; index < 0x70020; index++) changed[index] = 0x22;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.ok(plan.ranges.length >= 2);
  process.env.AETHER_FAKE_WRITE_DELAY_MS = "800";
  const running = flash.executeRestore(plan.planId, plan.confirmationPhrase);
  await waitFor(async () => (await calls(s)).some((call) => call.command === "write_flash"), "first write_flash");
  await flash.cancel();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.ok(!/完成：/.test(result.message.replace("未完成", "")), "cancellation must not claim completion");
  assert.match(result.message, /取消/);
  assert.equal(result.readBackVerified, false);
  assert.ok(result.remainingRanges.length > 0, "unfinished ranges are reported");
  console.log("PASS flash: cancelled restore reports unfinished ranges");
}

console.log("PASS flash: all directed regression cases (fake esptool device, no hardware)");
console.log("fixtures kept at " + root);
