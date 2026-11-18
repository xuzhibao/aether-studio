#!/usr/bin/env node
// File-backed fake of the esptool CLI surface used by Aether.
// It speaks the arguments and output of esptool 4.9 (default) or 5.x (`AETHER_FAKE_STYLE=v5`),
// but the "device" is a local image file. Test fixture only: no serial port, no real hardware.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const style = process.env.AETHER_FAKE_STYLE === "v5" ? "v5" : "v4";
const name = (base) => style === "v5" ? base.replace(/_/g, "-") : base;
const hyphenated = style === "v5";
const image = process.env.AETHER_FAKE_IMAGE;
const statePath = process.env.AETHER_FAKE_STATE;
const logPath = process.env.AETHER_FAKE_LOG;
const secure = process.env.AETHER_FAKE_SECURE === "1";
const chipLine = process.env.AETHER_FAKE_CHIP || "ESP32-C3 (QFN32) (revision v0.4)";
const mac = process.env.AETHER_FAKE_MAC || "60:55:f9:00:11:22";
const noMac = process.env.AETHER_FAKE_NO_MAC === "1";
const flashLabel = process.env.AETHER_FAKE_FLASH || "1MB";
const delay = Number(process.env.AETHER_FAKE_DELAY_MS || 0);
const writeDelay = Number(process.env.AETHER_FAKE_WRITE_DELAY_MS || 0);
const readFailOffsets = (process.env.AETHER_FAKE_READ_FAIL_OFFSETS || "").split(",").filter(Boolean).map((value) => parseInt(value, 10));
const readFailTimes = Number(process.env.AETHER_FAKE_READ_FAIL_TIMES || 0);
const writeFailOffset = process.env.AETHER_FAKE_WRITE_FAIL_OFFSET ? parseInt(process.env.AETHER_FAKE_WRITE_FAIL_OFFSET, 10) : -1;
const writeMangle = process.env.AETHER_FAKE_WRITE_MANGLE === "1";
const shortOffset = process.env.AETHER_FAKE_READ_SHORT_OFFSET ? parseInt(process.env.AETHER_FAKE_READ_SHORT_OFFSET, 10) : -1;
const noWrite = process.env.AETHER_FAKE_NO_WRITE === "1";
const noSecurity = process.env.AETHER_FAKE_NO_SECURITY === "1";
// v4.x takes these as defaults for the matching options; a non-keep value rewrites the image header.
const envFlashParams = ["ESPTOOL_FF", "ESPTOOL_FM", "ESPTOOL_FS"].some((key) => process.env[key] && process.env[key] !== "keep");
const knownOptions = new Set([
  "-h", "--help", "--port", "-p", "--baud", "-b", "--before", "-a", "--after", "--no-stub", "--trace", "--chip", "--override-vddsdio",
  "--no-progress", "--flash_size", "-fs", "--flash-size", "--spi-connection", "-sc",
  "--flash_mode", "-fm", "--flash-mode", "--flash_freq", "-ff", "--flash-freq",
  "--erase-all", "-e", "--encrypt", "--compress", "-z", "--no-compress", "-u", "--force",
]);
if (!hyphenated) knownOptions.add("--verify");

const say = (text) => process.stdout.write(text + "\n");
const fail = (text, code = 2) => { process.stderr.write(text + "\n"); process.exit(code); };
const log = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n"); };
const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (args[0] === "version") { say("esptool.py v" + (hyphenated ? "5.0.0" : "4.9.0") + "\n" + (hyphenated ? "5.0.0" : "4.9.0")); process.exit(0); }

const commandNames = new Set([name("flash_id"), name("read_flash"), name("write_flash"), name("get_security_info"), "read_mac", "read-mac"]);
const commandIndex = args.findIndex((arg) => commandNames.has(arg));
const commandToken = commandIndex >= 0 ? args[commandIndex] : "";
const command = commandToken.replace(/-/g, "_");
const rest = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];
const all = args;

// Unknown options are a hard error, like argparse: this catches flash parameters and --verify on v5.
for (const token of all) if (token.startsWith("-") && !knownOptions.has(token)) fail("esptool: error: unrecognized arguments: " + token);

if (args[0] === "--help" || args.length === 0 || (command === "" && args.includes("--help"))) {
  const list = ["load_ram", "read_mem", "write_mem", ...(noWrite ? [] : [name("write_flash")]), "read_mac", name("flash_id"), name("read_flash"), "verify_flash", "erase_flash", "merge_bin", ...(noSecurity ? [] : [name("get_security_info")]), "version"];
  say(`usage: esptool [-h] [--port PORT] [--baud BAUD] [--no-stub] [--after {hard_reset,no_reset}] {${list.join(",")}}`);
  say(`  ${name("read_flash")}          Read SPI flash content`);
  if (!noWrite) say(`  ${name("write_flash")}         Write a binary blob to flash`);
  say(`  ${name("flash_id")}            Read SPI flash manufacturer and device ID`);
  if (!noSecurity) say(`  ${name("get_security_info")}   Get some security-related data`);
  process.exit(0);
}
if (command === "write_flash" && args.includes("--help")) {
  if (noWrite) fail("invalid choice: '" + commandToken + "'", 2);
  const verify = hyphenated ? "" : " [--verify]";
  say(`usage: esptool ${commandToken} [-h] [--erase-all] [--flash_freq {keep,80m,60m,40m}] [--flash_mode {keep,qio,qout,dio,dout}] [--flash_size {detect,keep,1MB,2MB,4MB,8MB,16MB}]${verify} [--compress | --no-compress] <address> <filename>`);
  say("  --flash_freq {keep,...}  SPI Flash frequency");
  say("  --flash_mode {keep,...}  SPI Flash mode");
  say("  --flash_size {detect,keep,...}  SPI Flash size");
  if (!hyphenated) say("  --verify  Verify just-written data on flash");
  process.exit(0);
}
if (command === "get_security_info" && args.includes("--help")) {
  if (noSecurity) fail("invalid choice: '" + commandToken + "'", 2);
  say("usage: esptool " + commandToken + " [-h]");
  process.exit(0);
}

// Parse options after the command; global options may also precede it.
let port = "";
let baud = 115200;
let verify = false;
const flags = new Set();
const values = new Map();
for (let index = 0; index < all.length; index++) {
  const token = all[index];
  if (commandNames.has(token)) continue;
  if (token === "--port" || token === "-p") { port = all[++index]; continue; }
  if (token === "--baud" || token === "-b") { baud = Number(all[++index]); continue; }
  if (token === "--verify") { verify = true; flags.add(token); continue; }
  if (token.startsWith("-")) {
    flags.add(token);
    if (["--before", "--after", "-a", "--flash_mode", "--flash-mode", "-fm", "--flash_freq", "--flash-freq", "-ff", "--flash_size", "--flash-size", "-fs", "--spi-connection", "-sc"].includes(token)) values.set(token, all[++index]);
  }
}
const positional = [];
for (let index = 0; index < rest.length; index++) {
  const token = rest[index];
  if (token.startsWith("-")) {
    if (["--before", "--after", "-a", "--flash_mode", "--flash-mode", "-fm", "--flash_freq", "--flash-freq", "-ff", "--flash_size", "--flash-size", "-fs", "--spi-connection", "-sc"].includes(token)) index++;
    continue;
  }
  positional.push(token);
}

log({ command, port, baud, args, style });

if (!command) fail("no command specified", 2);
if (!port) fail("No serial port specified", 2);

function imageBytes() {
  if (!image || !existsSync(image)) fail("fake image not found", 3);
  return readFileSync(image);
}
function count(key) {
  if (!statePath || !existsSync(statePath)) return 0;
  try { return Number(JSON.parse(readFileSync(statePath, "utf8"))[key] || 0); } catch { return 0; }
}
function bump(key) {
  if (!statePath) return;
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }
  state[key] = count(key) + 1;
  writeFileSync(statePath, JSON.stringify(state));
}

if (command === "flash_id") {
  say("esptool.py v" + (hyphenated ? "5.0.0" : "4.9.0"));
  say("Serial port " + port);
  say("Connecting....");
  say("Detecting chip type... " + chipLine.split(" ")[0]);
  say("Chip is " + chipLine);
  say("Features: WiFi, BLE");
  say("Crystal is 40MHz");
  if (!noMac) say("MAC: " + mac);
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
  const [address, size, filename] = positional;
  const offset = Number(address); const length = Number(size);
  if (Number.isNaN(offset) || Number.isNaN(length) || !filename) fail("invalid read_flash arguments");
  if (readFailOffsets.includes(offset) && count("read:" + offset) < readFailTimes) { bump("read:" + offset); fail("A fatal error occurred: Failed to read flash data (Corrupt data)"); }
  const bytes = imageBytes();
  if (offset + length > bytes.length) fail("read beyond fake flash size");
  if (delay) sleep(delay);
  // One short read exercises the length check; the retry then returns the full block.
  const short = offset === shortOffset && count("short:" + offset) < 1;
  if (short) { bump("short:" + offset); writeFileSync(filename, bytes.subarray(offset, offset + Math.max(0, length - 1))); }
  else writeFileSync(filename, bytes.subarray(offset, offset + length));
  say("Read " + length + " bytes at 0x" + offset.toString(16) + " in 0.1 seconds");
  process.exit(0);
}

if (command === "write_flash") {
  const [address, filename] = positional;
  const offset = Number(address);
  if (Number.isNaN(offset) || !filename) fail("invalid write_flash arguments");
  if (flags.has("--erase-all") || flags.has("-e")) log({ warning: "erase-all requested" });
  if (offset === writeFailOffset) fail("A fatal error occurred: Write failed at 0x" + offset.toString(16));
  const bytes = imageBytes();
  const payload = readFileSync(filename);
  if (offset + payload.length > bytes.length) fail("write beyond fake flash size");
  if (writeDelay) sleep(writeDelay);
  payload.copy(bytes, offset);
  // Real esptool rewrites the bootloader header when flash parameters are supplied (or defaulted from env).
  const explicit = ["--flash_mode", "--flash-mode", "-fm", "--flash_freq", "--flash-freq", "-ff", "--flash_size", "--flash-size", "-fs"].some((flag) => flags.has(flag));
  if (explicit || envFlashParams) {
    bytes[0] = 0x00; bytes[1] = 0x00; bytes[2] = 0x00;
    log({ rewrittenHeader: true, envFlashParams, args });
  }
  if (writeMangle && payload.length > 0) bytes[offset] = bytes[offset] ^ 0xff;
  writeFileSync(image, bytes);
  say("Writing at 0x" + offset.toString(16) + "... (100 %)");
  if (verify) say("Hash of data verified.");
  say("Leaving...\nHard resetting via RTS pin...");
  process.exit(0);
}

if (command === "read_mac") { if (!noMac) say("MAC: " + mac); process.exit(0); }
fail("unhandled fake esptool command: " + command);
