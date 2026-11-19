#!/usr/bin/env node
// Builds the QEMU validation image with a real PlatformIO invocation and records
// the exact tool versions and SHA-256 of both the app image and the merged image.
//
// The merged 16 MB flash image is a QEMU artifact only. It carries this example's
// bootloader and the device-matching partition table; the app is placed in ota_0 so
// the same app payload that the device receives in ota_1 is what QEMU executes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const env = process.env.FWVAL_PIO_ENV ?? "esp32c3-qemu-uart0";
const coreDir = process.env.PLATFORMIO_CORE_DIR ?? path.join(homedir(), ".platformio");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function hostPath(...parts) {
  return path.join(...parts);
}

async function findPio() {
  if (process.env.PIO_BIN) return process.env.PIO_BIN;
  const candidate = process.platform === "win32"
    ? hostPath(homedir(), ".platformio", "penv", "Scripts", "pio.exe")
    : hostPath(homedir(), ".platformio", "penv", "bin", "pio");
  return (await exists(candidate)) ? candidate : "pio";
}

async function findPython() {
  if (process.env.PIO_PYTHON) return process.env.PIO_PYTHON;
  // The core dir may hold only packages while the penv stays in the default location;
  // esptool needs the penv interpreter because it ships pyserial.
  const candidates = process.platform === "win32"
    ? [
        hostPath(coreDir, "penv", "Scripts", "python.exe"),
        hostPath(homedir(), ".platformio", "penv", "Scripts", "python.exe"),
      ]
    : [hostPath(coreDir, "penv", "bin", "python"), hostPath(homedir(), ".platformio", "penv", "bin", "python")];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

async function findEsptool() {
  if (process.env.ESPTOOL_PY) return process.env.ESPTOOL_PY;
  for (const root of [coreDir, path.join(homedir(), ".platformio")]) {
    const candidate = hostPath(root, "packages", "tool-esptoolpy", "esptool.py");
    if (await exists(candidate)) return candidate;
  }
  throw new Error("esptool.py not found in the PlatformIO packages directory");
}

const pio = await findPio();
const version = await run(pio, ["--version"]);
if (version.code !== 0) {
  console.error(version.stderr || version.stdout);
  process.exit(2);
}

const build = await run(pio, ["run", "-e", env]);
if (build.code !== 0) {
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  process.exit(build.code ?? 1);
}

const buildDir = path.join(process.env.PLATFORMIO_BUILD_DIR ?? path.join(project, ".pio", "build"), env);
const artifacts = {
  bootloader: path.join(buildDir, "bootloader.bin"),
  partitions: path.join(buildDir, "partitions.bin"),
  firmware: path.join(buildDir, "firmware.bin"),
};
for (const [label, file] of Object.entries(artifacts)) {
  if (!(await exists(file))) throw new Error(`${label} artifact missing: ${file}`);
}

const python = await findPython();
const esptool = await findEsptool();
const esptoolVersion = await run(python, [esptool, "version"]);
const merged = path.join(buildDir, "flash-qemu.bin");
const merge = await run(python, [
  esptool,
  "--chip", "esp32c3",
  "merge_bin",
  "-o", merged,
  "--flash_mode", "dio",
  "--flash_freq", "80m",
  "--flash_size", "16MB",
  "--fill-flash-size", "16MB",
  "0x0", artifacts.bootloader,
  "0x8000", artifacts.partitions,
  "0x100000", artifacts.firmware,
]);
if (merge.code !== 0) {
  process.stdout.write(merge.stdout);
  process.stderr.write(merge.stderr);
  process.exit(merge.code ?? 1);
}

const report = {
  env,
  platformio: version.stdout.trim(),
  python: (await run(python, ["--version"])).stdout.trim(),
  esptool: (esptoolVersion.code === 0 ? esptoolVersion.stdout.trim().split("\n")[0] : "unknown"),
  artifacts: {
    firmware: { path: artifacts.firmware, size: (await stat(artifacts.firmware)).size, sha256: await sha256(artifacts.firmware) },
    merged: { path: merged, size: (await stat(merged)).size, sha256: await sha256(merged) },
  },
  note: "QEMU-only 16 MB image: device-matching partition table, app in ota_0; never write it to the device.",
};
const text = JSON.stringify(report, null, 2);
console.log(text);
if (process.env.FWVAL_REPORT) {
  await mkdir(path.dirname(process.env.FWVAL_REPORT), { recursive: true });
  await writeFile(process.env.FWVAL_REPORT, text + "\n", "utf8");
}
