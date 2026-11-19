import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliEsptool, FlashService, deviceIdentityMatches, diffRanges, parseFlashId, parseSecurity } from "../desktop/flash";
import { ToolService } from "../desktop/tools";
import { createEsptoolRunner, resolveEsptoolCommand } from "../desktop/plugins/esptool";
import { DeviceLease } from "../desktop/deviceLock";
import type { FlashBackupMetadata, FlashBackupOptions, FlashRestorePrepareOptions } from "../shared/flash";

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
  for (const key of Object.keys(process.env)) if (key.startsWith("AETHER_FAKE_") || key === "ESPTOOL_FF" || key === "ESPTOOL_FM" || key === "ESPTOOL_FS") delete process.env[key];
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
const writes = (list: Awaited<ReturnType<typeof calls>>) => list.filter((call) => call.command === "write_flash");

// ---- pure parsers and identity ----
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
const identity = { chip: "ESP32-C3", flashSizeBytes: 1024 * 1024, flashManufacturerId: "0xef", flashDeviceId: "0x4018", mac: "60:55:f9:00:11:22" };
assert.equal(deviceIdentityMatches(identity, identity), true);
assert.equal(deviceIdentityMatches(identity, { ...identity, mac: "" }), false, "a missing MAC is not a match");
assert.equal(deviceIdentityMatches(identity, { ...identity, mac: "60:55:f9:99:88:77" }), false);

// ---- shared port lease: monitor, task and flash cannot overlap ----
{
  const lease = new DeviceLease();
  const flash = lease.claim("flash", "COM4");
  assert.throws(() => lease.claim("monitor"), /Flash/);
  assert.throws(() => lease.claim("task", "COM4"), /Flash/);
  assert.equal(lease.release({ id: flash.id + 1000, owner: "flash", port: "COM4" }), false, "a stale token must not free the lease");
  assert.equal(lease.holder(), "flash", "a non-owner release must not free the lease");
  lease.release(flash);
  assert.equal(lease.holder(), null);
  const task = lease.claim("task", "COM4");
  assert.throws(() => lease.claim("flash", "COM4"), /构建\/上传任务/);
  assert.equal(lease.holds(task), true);
  assert.equal(lease.release(task), true);
  assert.equal(lease.release(task), false, "a second release of the same token is harmless");
  assert.equal(lease.holder(), null);
  // A late close from an operation that already ended must not free the owner that came after it.
  const older = lease.claim("task", "COM4");
  lease.release(older);
  const monitor = lease.claim("monitor", "COM4");
  assert.equal(lease.release(older), false, "an old close must not free a newer monitor session");
  assert.equal(lease.holder(), "monitor");
  lease.release(monitor);
  console.log("PASS flash: one device lease is mutually exclusive and release is token-scoped");
}

// ---- tool discovery: a .py entry resolves to an absolute script plus its interpreter ----
{
  const tools = new ToolService(() => path.join(root, "tools.json"));
  createEsptoolRunner(tools);
  const local = "C:/Users/Bao/.platformio/packages/tool-esptoolpy/esptool.py";
  if (existsSync(local)) {
    await tools.setPath("esptool", local);
    const command = resolveEsptoolCommand(tools);
    assert.match(path.basename(command.executable), /python/i);
    assert.deepEqual(command.prefixArgs, [local]);
    console.log("PASS flash: esptool.py resolves to an absolute script and Python interpreter");
  }
}

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
  // The successful lower rate carries over to later chunks instead of failing each one again.
  const later = (await calls(s)).filter((call) => call.command === "read_flash" && call.args.includes("0x20000"));
  assert.ok(later.every((call) => call.baud === 115200));
  await assert.rejects(flash.startBackup(options), /已存在|不会覆盖/);
  console.log("PASS flash: chunk retry + baud memory + digest + no overwrite");
}

// ---- backup: the cache may not live inside the opened project ----
{
  const s = await scenario("cache-inside");
  const bad = new FlashService(esptool, { cacheRoot: path.join(workspace, "cache"), workspaceRoot: () => workspace });
  await assert.rejects(bad.startBackup(backupOptions(s, "cache-inside")), /缓存目录不能位于/);
  console.log("PASS flash: cache directory inside the project is refused");
}

// ---- backup: a short read is retried after the length check ----
{
  const s = await scenario("short");
  process.env.AETHER_FAKE_READ_SHORT_OFFSET = String(0x10000);
  const flash = service();
  const result = await flash.startBackup(backupOptions(s, "short"));
  assert.ok(result.retriesUsed >= 1);
  assert.equal(result.metadata.sha256, sha(s.bytes));
  console.log("PASS flash: short read is detected and retried");
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
  const changed = Buffer.from(original);
  for (let index = 0x10; index < 0x20; index++) changed[index] = 0x55;
  for (let index = 0x40000; index < 0x40020; index++) changed[index] = 0x66;
  await fs.writeFile(s.image, changed);

  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.blocked, "");
  assert.equal(plan.verification.wholeImage, true);
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
  const list = await calls(s);
  const writeCalls = writes(list);
  assert.ok(writeCalls.length > 0);
  for (const write of writeCalls) {
    assert.ok(!write.args.some((arg: string) => /^--flash[-_](mode|freq|size)$/.test(arg)), "write_flash never receives flash parameters: " + write.args.join(" "));
    assert.ok(!write.args.includes("--erase-all") && !write.args.includes("-e"), "restore never erases the whole chip");
  }
  assert.ok(!list.some((call) => call.rewrittenHeader), "the fixture must not have rewritten the bootloader header");
  console.log("PASS flash: restore keeps the header, writes only differences, verifies read-back");
}

// ---- restore: ESPTOOL_FF/FM/FS from the environment cannot rewrite the header ----
{
  const s = await scenario("env-flash");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "env-flash"));
  const original = await fs.readFile(s.image);
  const changed = Buffer.from(original);
  changed[0x10] = 0x99;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.blocked, "");
  process.env.ESPTOOL_FM = "dio";
  process.env.ESPTOOL_FF = "40m";
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "completed", result.message);
  assert.deepEqual(await fs.readFile(s.image), original);
  assert.ok(!(await calls(s)).some((call) => call.rewrittenHeader), "the runner pins ESPTOOL_* to keep");
  console.log("PASS flash: user ESPTOOL_* defaults cannot rewrite the header");
}

// ---- restore: a backup replaced after prepare is refused before writing ----
{
  const s = await scenario("tamper");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "tamper"));
  const changed = Buffer.from(await fs.readFile(s.image));
  changed[0x20000] ^= 0xff;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.ok(plan.ranges.length > 0);
  const before = writes(await calls(s)).length;
  const bytes = await fs.readFile(backup.outputPath);
  bytes[0x30000] ^= 0xff;
  await fs.writeFile(backup.outputPath, bytes);
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "failed");
  assert.match(result.message, /准备后被修改|SHA-256/);
  assert.equal(writes(await calls(s)).length, before, "a replaced backup is not written");
  assert.deepEqual(await fs.readFile(s.image), changed, "the device was not touched");
  console.log("PASS flash: backup is re-verified against the prepared digest before writing");
}

// ---- restore: identity must still be present at write time ----
{
  const s = await scenario("no-mac");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "no-mac"));
  const changed = Buffer.from(await fs.readFile(s.image));
  changed[0x50000] ^= 0xff;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.blocked, "");
  process.env.AETHER_FAKE_NO_MAC = "1";
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "failed");
  assert.match(result.message, /身份/);
  assert.equal(writes(await calls(s)).length, 0);
  console.log("PASS flash: a missing MAC at write time is refused");
}

// ---- restore: a truncated file with a matching sidecar is not a whole-image backup ----
{
  const s = await scenario("short-image");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "short-image"));
  const truncated = path.join(OUT, "truncated.bin");
  const bytes = await fs.readFile(backup.outputPath);
  const part = bytes.subarray(0, 512 * 1024);
  await fs.writeFile(truncated, part);
  const meta = JSON.parse(await fs.readFile(backup.outputPath + ".meta.json", "utf8")) as FlashBackupMetadata;
  meta.fileLength = part.length;
  meta.sha256 = sha(part);
  await fs.writeFile(truncated + ".meta.json", JSON.stringify(meta, null, 2));
  const plan = await flash.prepareRestore(restoreOptions(s, truncated));
  assert.match(plan.blocked, /不是整片镜像/);
  assert.equal(plan.verification.wholeImage, false);
  assert.deepEqual(plan.ranges, []);
  console.log("PASS flash: a truncated sidecar cannot pass as a whole-image backup");
}

// ---- restore: a write failure reports the failed offset and unattempted ranges ----
{
  const s = await scenario("write-fail");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "write-fail"));
  const changed = Buffer.from(await fs.readFile(s.image));
  for (const offset of [0x10000, 0x70000, 0x90000]) for (let index = offset; index < offset + 0x20; index++) changed[index] = 0x33;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.ranges.length, 3);
  process.env.AETHER_FAKE_WRITE_FAIL_OFFSET = String(0x70000);
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "failed");
  assert.equal(result.writtenRanges.length, 2, "the first range and the failed attempt are reported");
  assert.deepEqual(result.writtenRanges.map((range) => range.offset), [0x10000, 0x70000]);
  assert.deepEqual(result.remainingRanges.map((range) => range.offset), [0x90000], "only unattempted ranges remain");
  assert.equal(flash.snapshot().progress?.failedOffset, 0x70000);
  assert.equal(result.readBackVerified, false);
  console.log("PASS flash: write failure reports the exact offset and unattempted ranges");
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
  assert.equal(flash.snapshot().progress?.failedOffset, plan.ranges[0].offset);
  console.log("PASS flash: read-back mismatch reports failure");
}

// ---- restore: protected or unverifiable devices are refused ----
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
  assert.equal(writes(await calls(s)).length, 0);
  await assert.rejects(flash.executeRestore(plan.planId, plan.confirmationPhrase), /拒绝/);
  console.log("PASS flash: secure-boot device refuses restore");
}
{
  const s = await scenario("no-security");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "no-security"));
  process.env.AETHER_FAKE_NO_SECURITY = "1";
  const limited = service();
  const plan = await limited.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.match(plan.blocked, /无法只读确认/);
  console.log("PASS flash: unverifiable security state refuses restore");
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

// ---- restore: esptool 5 hyphenated commands and no --verify ----
{
  const s = await scenario("v5");
  process.env.AETHER_FAKE_STYLE = "v5";
  const flash = service();
  const caps = await flash.capabilities();
  assert.equal(caps.version, "5.0.0");
  assert.equal(caps.readFlash, true);
  assert.equal(caps.writeFlash, true);
  assert.equal(caps.preservesImageHeaders, true);
  assert.equal(caps.verifyOption, false, "esptool 5 write-flash has no --verify");
  const backup = await flash.startBackup(backupOptions(s, "v5"));
  assert.equal(backup.metadata.sha256, sha(s.bytes));
  const changed = Buffer.from(await fs.readFile(s.image));
  changed[0x10000] ^= 0xff;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.blocked, "");
  const result = await flash.executeRestore(plan.planId, plan.confirmationPhrase);
  assert.equal(result.status, "completed", result.message);
  assert.deepEqual(await fs.readFile(s.image), s.bytes);
  const list = await calls(s);
  assert.ok(list.some((call) => call.command === "write_flash" && call.args.includes("write-flash")));
  assert.ok(writes(list).every((call) => !call.args.includes("--verify")), "no --verify when the tool lacks it");
  console.log("PASS flash: esptool 5 hyphenated commands work without --verify");
}

// ---- restore: cancellation reports attempted and unattempted ranges ----
{
  const s = await scenario("cancel-restore");
  const flash = service();
  const backup = await flash.startBackup(backupOptions(s, "cancel-restore"));
  const changed = Buffer.from(await fs.readFile(s.image));
  for (const offset of [0x10000, 0x70000, 0x90000]) for (let index = offset; index < offset + 0x20; index++) changed[index] = 0x22;
  await fs.writeFile(s.image, changed);
  const plan = await flash.prepareRestore(restoreOptions(s, backup.outputPath));
  assert.equal(plan.ranges.length, 3);
  process.env.AETHER_FAKE_WRITE_DELAY_MS = "800";
  const running = flash.executeRestore(plan.planId, plan.confirmationPhrase);
  await waitFor(async () => writes(await calls(s)).length >= 1, "first write_flash");
  await flash.cancel();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.match(result.message, /取消/);
  assert.ok(!result.message.includes("完成："));
  assert.equal(result.readBackVerified, false);
  assert.ok(result.writtenRanges.length >= 1);
  assert.ok(result.remainingRanges.length >= 1, "unattempted ranges are reported");
  assert.equal(result.writtenRanges.length + result.remainingRanges.length, plan.ranges.length);
  console.log("PASS flash: cancelled restore separates attempted and unattempted ranges");
}

console.log("PASS flash: all directed regression cases (fake esptool device, no hardware)");
console.log("fixtures kept at " + root);
