#!/usr/bin/env node
// File-backed fake of the esptool CLI surface used by Aether.
// It speaks the same arguments and output as esptool 4.9, but the "device" is a local image file.
// It is a test fixture only: it never opens a serial port or touches real hardware.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const image = process.env.AETHER_FAKE_IMAGE;
const statePath = process.env.AETHER_FAKE_STATE;
const logPath = process.env.AETHER_FAKE_LOG;
const secure = process.env.AETHER_FAKE_SECURE === "1";
const chipLine = process.env.AETHER_FAKE_CHIP || "ESP32-C3 (QFN32) (revision v0.4)";
const mac = process.env.AETHER_FAKE_MAC || "60:55:f9:00:11:22";
const flashLabel = process.env.AETHER_FAKE_FLASH || "1MB";
const delay = Number(process.env.AETHER_FAKE_DELAY_MS || 0);
const writeDelay = Number(process.env.AETHER_FAKE_WRITE_DELAY_MS || 0);
const readFailOffsets = (process.env.AETHER_FAKE_READ_FAIL_OFFSETS || "").split(",").filter(Boolean).map((value) => parseInt(value, 10));
const readFailTimes = Number(process.env.AETHER_FAKE_READ_FAIL_TIMES || 0);
const writeFailOffset = process.env.AETHER_FAKE_WRITE_FAIL_OFFSET ? parseInt(process.env.AETHER_FAKE_WRITE_FAIL_OFFSET, 10) : -1;
const writeMangle = process.env.AETHER_FAKE_WRITE_MANGLE === "1";
// Subcommand options arrive after the command name, so scan the whole argv.
const hasFlashParams = ["--flash_mode", "-fm", "--flash_freq", "-ff", "--flash_size", "-fs"].some((flag) => args.includes(flag));

const say = (text) => process.stdout.write(text + "\n");
const fail = (text, code = 2) => { process.stderr.write(text + "\n"); process.exit(code); };
const log = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n"); };
const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (args[0] === "version") { say("esptool.py v4.9.0\n4.9.0"); process.exit(0); }
if (args[0] === "--help" || args.length === 0) {
  const noWrite = process.env.AETHER_FAKE_NO_WRITE === "1";
  const noSecurity = process.env.AETHER_FAKE_NO_SECURITY === "1";
  const list = ["load_ram", "read_mem", "write_mem", ...(noWrite ? [] : ["write_flash"]), "read_mac", "flash_id", "read_flash", "verify_flash", "erase_flash", "merge_bin", ...(noSecurity ? [] : ["get_security_info"]), "version"];
  say(`usage: esptool [-h] [--port PORT] [--baud BAUD] [--no-stub] [--after {hard_reset,no_reset}] {${list.join(",")}}`);
  say("  read_flash          Read SPI flash content");
  if (!noWrite) say("  write_flash         Write a binary blob to flash");
  say("  flash_id            Read SPI flash manufacturer and device ID");
  if (!noSecurity) say("  get_security_info   Get some security-related data");
  process.exit(0);
}
if (args[0] === "write_flash" && args.includes("--help")) {
  if (process.env.AETHER_FAKE_NO_WRITE === "1") fail("invalid choice: 'write_flash'", 2);
  say("usage: esptool write_flash [-h] [--erase-all] [--flash_freq {keep,80m,60m,40m}] [--flash_mode {keep,qio,qout,dio,dout}] [--flash_size {detect,keep,1MB,2MB,4MB,8MB,16MB}] [--verify] [--compress | --no-compress] <address> <filename>");
  say("  --flash_freq {keep,...}  SPI Flash frequency");
  say("  --flash_mode {keep,...}  SPI Flash mode");
  say("  --flash_size {detect,keep,...}  SPI Flash size");
  say("  --verify  Verify just-written data on flash");
  process.exit(0);
}
if (args[0] === "get_security_info" && args.includes("--help")) {
  if (process.env.AETHER_FAKE_NO_SECURITY === "1") fail("invalid choice: 'get_security_info'", 2);
  say("usage: esptool get_security_info [-h]");
  process.exit(0);
}

// Global options may precede the subcommand.
const commands = new Set(["flash_id", "read_flash", "write_flash", "get_security_info", "read_mac"]);
let index = 0;
let port = "";
let baud = 115200;
let verify = false;
const flags = new Set();
for (; index < args.length; index++) {
  const arg = args[index];
  if (commands.has(arg)) break;
  if (arg === "--port" || arg === "-p") { port = args[++index]; continue; }
  if (arg === "--baud" || arg === "-b") { baud = Number(args[++index]); continue; }
  if (arg.startsWith("--")) { flags.add(arg); if (arg === "--verify") verify = true; continue; }
}
const command = args[index];
const rest = args.slice(index + 1);
log({ command, port, baud, args });

if (!command) fail("no command specified", 2);
if (!port) fail("No serial port specified", 2);

function imageBytes() {
  if (!image || !existsSync(image)) fail("fake image not found", 3);
  return readFileSync(image);
}
function failureCount(key) {
  if (!statePath || !existsSync(statePath)) return 0;
  try { return Number(JSON.parse(readFileSync(statePath, "utf8"))[key] || 0); } catch { return 0; }
}
function bump(key) {
  if (!statePath) return;
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }
  state[key] = failureCount(key) + 1;
  writeFileSync(statePath, JSON.stringify(state));
}

if (command === "flash_id") {
  say("esptool.py v4.9.0");
  say("Serial port " + port);
  say("Connecting....");
  say("Detecting chip type... " + chipLine.split(" ")[0]);
  say("Chip is " + chipLine);
  say("Features: WiFi, BLE");
  say("Crystal is 40MHz");
  say("MAC: " + mac);
  say("Uploading stub...\nRunning stub...\nStub running...");
  say("Manufacturer: 0xef");
  say("Device: 0x4018");
  say("Detected flash size: " + flashLabel);
  say("Hard resetting via RTS pin...");
  process.exit(0);
}

if (command === "get_security_info") {
  say("\nSecurity Information:\n=====================");
  say("Flags: 0x00000000 (0b0)");
  say("Secure Boot: " + (secure ? "Enabled" : "Disabled"));
  say("Flash Encryption: " + (secure ? "Enabled" : "Disabled"));
  say("SPI Boot Crypt Count (SPI_BOOT_CRYPT_CNT): 0x" + (secure ? "f" : "0"));
  process.exit(0);
}

if (command === "read_flash") {
  const [address, size, filename] = rest;
  const offset = Number(address); const length = Number(size);
  if (Number.isNaN(offset) || Number.isNaN(length) || !filename) fail("invalid read_flash arguments");
  const failing = readFailOffsets.includes(offset) && failureCount("read:" + offset) < readFailTimes;
  if (failing) { bump("read:" + offset); fail("A fatal error occurred: Failed to read flash data (Corrupt data)"); }
  const bytes = imageBytes();
  if (offset + length > bytes.length) fail("read beyond fake flash size");
  if (delay) sleep(delay);
  writeFileSync(filename, bytes.subarray(offset, offset + length));
  say("Read " + length + " bytes at 0x" + offset.toString(16) + " in 0.1 seconds");
  process.exit(0);
}

if (command === "write_flash") {
  const positional = rest.filter((value) => !value.startsWith("--"));
  const [address, filename] = positional;
  const offset = Number(address);
  if (Number.isNaN(offset) || !filename) fail("invalid write_flash arguments");
  if (flags.has("--erase-all") || flags.has("-e")) {
    // The product must never ask for a full erase; make that visible in the log.
    log({ warning: "erase-all requested" });
  }
  if (offset === writeFailOffset) fail("A fatal error occurred: Write failed at 0x" + offset.toString(16));
  const bytes = imageBytes();
  const payload = readFileSync(filename);
  if (offset + payload.length > bytes.length) fail("write beyond fake flash size");
  if (writeDelay) sleep(writeDelay);
  payload.copy(bytes, offset);
  // Real esptool rewrites the second-stage bootloader header when flash parameters are supplied.
  if (hasFlashParams) {
    bytes[0] = 0x00; bytes[1] = 0x00; bytes[2] = 0x00;
    log({ rewrittenHeader: true, args });
  }
  if (writeMangle && payload.length > 0) bytes[offset] = bytes[offset] ^ 0xff;
  writeFileSync(image, bytes);
  say("Writing at 0x" + offset.toString(16) + "... (100 %)");
  if (verify) say("Hash of data verified.");
  say("Leaving...\nHard resetting via RTS pin...");
  process.exit(0);
}

if (command === "read_mac") { say("MAC: " + mac); process.exit(0); }
fail("unhandled fake esptool command: " + command);
