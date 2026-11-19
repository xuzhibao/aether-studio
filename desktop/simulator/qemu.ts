import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertEnvironmentName } from "../buildInputs";
import type { ToolDefinition, ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";

/**
 * Espressif's QEMU fork is the only supported emulator: the upstream binary has no ESP32 machine.
 * The version probe is a real `--version` run through ToolService; the path is a trusted local
 * executable (setting, AETHER_QEMU_RISCV32, or PATH) and never a shell string.
 */
export const qemuEsp32c3Tool: ToolDefinition = {
  id: "qemu-esp32c3", name: "Espressif QEMU (ESP32-C3)", env: "AETHER_QEMU_RISCV32", defaultExecutable: "qemu-system-riscv32", versionArgs: ["--version"],
  description: "Espressif 官方 qemu-system-riscv32；在宿主上运行真实的 ESP32-C3 固件镜像。",
};

export type SimulatorStatus = "running" | "stopped" | "failed";
export type SimulatorStopReason = "timeout" | "cancel" | "exit";

/** One partition table entry copied from the built partitions.bin (not a host guess). */
export interface SimulatorPartition { type: number; subtype: number; offset: number; size: number; label: string }

export interface SimulatorSnapshot {
  id: string;
  provider: "qemu.esp32c3";
  status: SimulatorStatus;
  root: string;
  environment: string;
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  /** Real OS process id, so callers can confirm the process is gone after a stop. */
  pid: number | null;
  stopReason?: SimulatorStopReason;
  error?: string;
  qemu: { executable: string; version: string };
  /** The complete, fixed argv handed to spawn(); no user-provided arguments are appended. */
  argv: string[];
  /** Identity of the build record that authorized this run. */
  build: { recordSha256: string; inputHash: string; builtAt: string };
  app: { path: string; sha256: string; size: number };
  /** QEMU-private flash image. Its layout is not a physical-board deploy layout. */
  flash: { sha256: string; size: number; bootloaderOffset: number; partitionTableOffset: number; partitions: SimulatorPartition[] };
  /** Raw UART0 text (stdout). */
  uart: string;
  /** QEMU's own diagnostics (stderr), kept separate from the emulated board's UART. */
  diagnostics: string;
  /** Bounded combined view for display. */
  log: string;
}

export interface SimulatorStartOptions {
  environment: string;
  /** Wall-clock bound for one run. The service stops QEMU and waits for it to exit. */
  timeoutMs?: number;
}

export interface QemuSimulatorOptions {
  tools: ToolService;
  workspace: WorkspaceService;
  emit?: (snapshot: SimulatorSnapshot) => void;
  /** Moves the private temporary directory aside. Permanent deletion is never used. */
  trashItem?: (target: string) => Promise<void>;
}

interface BuildArtifactRecord { path: string; sha256: string; size: number }
interface BuildRecord {
  provider: string; status: string; root: string; environment: string;
  inputHash: string; startedAt: string; artifacts: BuildArtifactRecord[];
}

interface PreparedImages {
  bytes: Buffer;
  sha256: string;
  flashSize: number;
  app: { path: string; sha256: string; size: number };
  partitions: SimulatorPartition[];
  recordSha256: string;
  inputHash: string;
  builtAt: string;
}

const TOOL_ID = "qemu-esp32c3";
const BOOTLOADER_OFFSET = 0x0;
const PARTITION_TABLE_OFFSET = 0x8000;
const FLASH_SIZES = [2, 4, 8, 16].map((mb) => mb * 1024 * 1024);
const MAX_LOG = 250_000;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 300_000;
const DEFAULT_TIMEOUT = 30_000;

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const absent = (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; };
const clone = <T>(value: T): T => structuredClone(value);

/** Rejects a path whose components include a link, so every verified byte comes from the project itself. */
async function assertPlainPath(root: string, relative: string, label: string) {
  const parts = relative.split("/");
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || parts.some((part) => !part || part === "." || part === "..")) throw new Error(label + "路径无效：" + relative);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(absent);
    if (!stat) throw new Error(label + "不存在：" + relative);
    if (stat.isSymbolicLink()) throw new Error(label + "是符号链接，拒绝使用：" + relative);
  }
  const final = await fs.lstat(path.join(root, relative));
  if (!final.isFile()) throw new Error(label + "不是普通文件：" + relative);
}

/** Parses the built partition table; the app offset used by QEMU comes from here, not from a constant. */
export function parsePartitionTable(bytes: Buffer): SimulatorPartition[] {
  if (!bytes.length || bytes.length % 32 !== 0) throw new Error("分区表长度不是 32 字节的整数倍");
  const entries: SimulatorPartition[] = [];
  for (let index = 0; index < bytes.length; index += 32) {
    const entry = bytes.subarray(index, index + 32);
    if (entry[0] !== 0xaa || entry[1] !== 0x50) break;
    entries.push({ type: entry[2], subtype: entry[3], offset: entry.readUInt32LE(4), size: entry.readUInt32LE(8), label: entry.subarray(12, 28).toString("utf8").replace(/\0+$/, "") });
  }
  if (!entries.length) throw new Error("分区表没有任何有效条目");
  return entries;
}

/** Bootloader chooses ota_0 on a fresh flash; a factory-only table has no ota slot. */
function appPartition(partitions: SimulatorPartition[]) {
  const apps = partitions.filter((entry) => entry.type === 0x00);
  const ota0 = apps.find((entry) => entry.subtype === 0x10);
  const factory = apps.find((entry) => entry.subtype === 0x00);
  const selected = ota0 ?? factory;
  if (!selected) throw new Error("分区表里没有 app 分区（factory 或 ota_0）");
  if ((selected.offset & 0xffff) !== 0) throw new Error("app 分区偏移未按 64KB 对齐：" + selected.offset.toString(16));
  return selected;
}

function flashSizeFor(partitions: SimulatorPartition[]) {
  const end = Math.max(...partitions.map((entry) => entry.offset + entry.size));
  const size = FLASH_SIZES.find((candidate) => candidate >= end);
  if (!size) throw new Error("分区表超出 QEMU 支持的 16MB flash：" + end.toString(16));
  return size;
}

/**
 * Reads the successful platformio.build record written by TaskService, verifies every input and
 * artifact byte it names, and assembles a QEMU-only flash image in memory. The app payload is
 * copied byte-for-byte from the built firmware.bin and re-verified inside the assembled image.
 */
async function prepareImages(root: string, environment: string, workspace: WorkspaceService): Promise<PreparedImages> {
  assertEnvironmentName(environment);
  await assertPlainPath(root, ".aether/build.json", "构建记录");
  const recordBytes = await fs.readFile(path.join(root, ".aether", "build.json"));
  let parsed: unknown;
  try { parsed = JSON.parse(recordBytes.toString("utf8")); }
  catch (error) { throw new Error("构建记录不是有效 JSON：" + String(error)); }
  const record = parsed as Partial<BuildRecord>;
  if (!record || record.provider !== "platformio.build") throw new Error("构建记录不是 PlatformIO 构建");
  if (record.status !== "succeeded") throw new Error("最近的 PlatformIO 构建未成功（" + String(record.status) + "），请先重新构建");
  if (record.root !== root) throw new Error("构建记录属于另一个工程，拒绝运行");
  if (record.environment !== environment) throw new Error("构建记录的环境是 " + String(record.environment) + "，不是所选环境 " + environment);
  if (typeof record.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(record.inputHash) || typeof record.startedAt !== "string") throw new Error("构建记录缺少输入指纹或构建时间");
  if (!Array.isArray(record.artifacts) || !record.artifacts.length) throw new Error("构建记录没有产物");
  const artifacts = new Map<string, BuildArtifactRecord>();
  for (const entry of record.artifacts) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isInteger(entry.size) || entry.size < 0) throw new Error("构建记录的产物条目格式错误");
    const name = path.posix.basename(entry.path);
    if (artifacts.has(name)) throw new Error("构建记录中 " + name + " 出现多次，无法确定使用哪一份");
    artifacts.set(name, entry);
  }
  const pick = (name: string) => {
    const entry = artifacts.get(name);
    if (!entry) throw new Error("构建记录里没有 " + name + "；请重新构建该环境");
    return entry;
  };
  const firmware = pick("firmware.bin");
  const bootloader = pick("bootloader.bin");
  const partitions = pick("partitions.bin");
  const buildDirectory = path.posix.dirname(firmware.path);
  if (path.posix.dirname(bootloader.path) !== buildDirectory || path.posix.dirname(partitions.path) !== buildDirectory) throw new Error("bootloader、分区表与 firmware 不在同一构建目录，拒绝运行");
  const readVerified = async (entry: BuildArtifactRecord, label: string) => {
    await assertPlainPath(root, entry.path, label);
    const bytes = await fs.readFile(path.join(root, entry.path));
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(label + "与构建记录不一致（大小或 SHA-256），拒绝运行");
    return bytes;
  };
  // Re-check the project inputs before and after reading; a source edit must not be paired with old artifacts.
  const before = await workspace.fingerprint();
  if (before !== record.inputHash) throw new Error("工程输入与构建记录不一致，请重新构建后再运行模拟器");
  const bootloaderBytes = await readVerified(bootloader, "bootloader.bin");
  const partitionBytes = await readVerified(partitions, "partitions.bin");
  const appBytes = await readVerified(firmware, "firmware.bin");
  const parsedPartitions = parsePartitionTable(partitionBytes);
  const app = appPartition(parsedPartitions);
  if (app.size < appBytes.length) throw new Error("app 分区放不下 firmware.bin：" + appBytes.length + " > " + app.size);
  if (bootloaderBytes.length > PARTITION_TABLE_OFFSET) throw new Error("bootloader.bin 覆盖了分区表位置");
  if (PARTITION_TABLE_OFFSET + partitionBytes.length > app.offset) throw new Error("分区表与 app 分区重叠");
  if (bootloaderBytes[0] !== 0xe9) throw new Error("bootloader.bin 不是 ESP 镜像（首字节不是 0xE9）");
  const flashSize = flashSizeFor(parsedPartitions);
  const image = Buffer.alloc(flashSize, 0xff);
  bootloaderBytes.copy(image, BOOTLOADER_OFFSET);
  partitionBytes.copy(image, PARTITION_TABLE_OFFSET);
  appBytes.copy(image, app.offset);
  // The payload that QEMU will read back must be exactly the record's firmware bytes.
  if (sha256(image.subarray(app.offset, app.offset + appBytes.length)) !== firmware.sha256) throw new Error("QEMU 镜像中的 app 段与构建产物 SHA-256 不一致");
  if (sha256(image.subarray(BOOTLOADER_OFFSET, bootloaderBytes.length)) !== bootloader.sha256) throw new Error("QEMU 镜像中的 bootloader 段与构建产物 SHA-256 不一致");
  if (sha256(image.subarray(PARTITION_TABLE_OFFSET, PARTITION_TABLE_OFFSET + partitionBytes.length)) !== partitions.sha256) throw new Error("QEMU 镜像中的分区表段与构建产物 SHA-256 不一致");
  const after = await workspace.fingerprint();
  if (after !== before) throw new Error("校验构建产物期间工程输入发生变化，已取消运行");
  return { bytes: image, sha256: sha256(image), flashSize, app: { path: firmware.path, sha256: firmware.sha256, size: appBytes.length }, partitions: parsedPartitions, recordSha256: sha256(recordBytes), inputHash: record.inputHash, builtAt: record.startedAt };
}

const qemuArgs = (flashPath: string) => [
  "-display", "none",
  "-serial", "stdio",
  "-monitor", "none",
  "-machine", "esp32c3",
  "-drive", "file=" + flashPath + ",if=mtd,format=raw",
];

export class QemuSimulatorService {
  private job: { snapshot: SimulatorSnapshot; child: ChildProcess; done: Promise<void>; stop: (reason: SimulatorStopReason) => void } | null = null;
  private last: SimulatorSnapshot | null = null;
  constructor(private options: QemuSimulatorOptions) {}

  snapshot() { return this.last ? clone(this.last) : null; }

  private emit(snapshot: SimulatorSnapshot) {
    this.last = clone(snapshot);
    try { this.options.emit?.(clone(snapshot)); } catch { /* a listener must not break the process lifecycle */ }
  }

  async start(options: SimulatorStartOptions): Promise<SimulatorSnapshot> {
    if (this.job) throw new Error("模拟器已在运行，请先停止");
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    const environment = typeof options?.environment === "string" ? options.environment.trim() : "";
    let tempDir = "";
    let executable = "";
    let version = "";
    try {
      assertEnvironmentName(environment);
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
      if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT || timeoutMs > MAX_TIMEOUT) throw new Error("模拟器超时必须在 " + MIN_TIMEOUT + "–" + MAX_TIMEOUT + " 毫秒之间");
      const status = await this.options.tools.status(TOOL_ID);
      executable = status.executable;
      version = status.version;
      if (!status.available) throw new Error(status.error || "找不到 Espressif QEMU 可执行文件");
      if (!/\besp\b|esp_|espressif/i.test(version)) throw new Error("该 qemu-system-riscv32 不是 Espressif 官方构建：" + (version || "版本未知"));
      const images = await prepareImages(root, environment, this.options.workspace);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aether-qemu-"));
      const flashPath = path.join(tempDir, "flash.bin");
      if (/[,\r\n]/.test(flashPath)) throw new Error("临时目录路径包含 QEMU -drive 无法安全表达的字符");
      await fs.writeFile(flashPath, images.bytes, { flag: "wx" });
      const written = await fs.readFile(flashPath);
      if (sha256(written) !== images.sha256) throw new Error("QEMU flash 私有副本写入后校验失败");
      const argv = qemuArgs(flashPath);
      const snapshot: SimulatorSnapshot = {
        id: randomUUID(), provider: "qemu.esp32c3", status: "running", root, environment,
        startedAt: new Date().toISOString(), exitCode: null, pid: null,
        qemu: { executable, version }, argv,
        build: { recordSha256: images.recordSha256, inputHash: images.inputHash, builtAt: images.builtAt },
        app: images.app,
        flash: { sha256: images.sha256, size: images.flashSize, bootloaderOffset: BOOTLOADER_OFFSET, partitionTableOffset: PARTITION_TABLE_OFFSET, partitions: images.partitions },
        uart: "", diagnostics: "", log: "",
      };
      // The process is spawned only after the exact flash bytes and the fixed argv exist.
      const child = spawn(executable, argv, { cwd: tempDir, shell: false, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env } });
      snapshot.pid = child.pid ?? null;
      let settled = false;
      let requestedStop: SimulatorStopReason | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const emit = () => this.emit(snapshot);
      const kill = () => {
        const pid = child.pid;
        if (!pid) return;
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false }).on("error", () => {});
        else {
          try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
          killTimer = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }, 1500);
        }
      };
      const stop = (reason: SimulatorStopReason) => {
        if (settled || snapshot.status !== "running") return;
        if (!requestedStop) requestedStop = reason;
        kill();
      };
      const append = (channel: "uart" | "diagnostics", chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (channel === "uart") snapshot.uart = (snapshot.uart + text).slice(-MAX_LOG);
        else snapshot.diagnostics = (snapshot.diagnostics + text).slice(-MAX_LOG);
        snapshot.log = (snapshot.log + text).slice(-MAX_LOG);
        emit();
      };
      const cleanup = async () => {
        if (!this.options.trashItem) {
          snapshot.diagnostics = (snapshot.diagnostics + "\n[aether] 未配置回收站，私有临时文件保留：" + tempDir).slice(-MAX_LOG);
          return;
        }
        try { await this.options.trashItem(tempDir); }
        catch (error) { snapshot.diagnostics = (snapshot.diagnostics + "\n[aether] 私有临时文件未清理：" + tempDir + "（" + String(error) + "）").slice(-MAX_LOG); }
      };
      const settle = async () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        await cleanup();
        this.job = null;
        emit();
        finish();
      };
      timer = setTimeout(() => stop("timeout"), timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => append("uart", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("diagnostics", chunk));
      child.on("error", (error) => {
        snapshot.error = "无法启动或运行 QEMU：" + error.message;
        snapshot.status = "failed";
        snapshot.endedAt = new Date().toISOString();
        void settle();
      });
      child.on("close", (code) => {
        if (settled) return;
        snapshot.exitCode = code;
        snapshot.endedAt = new Date().toISOString();
        snapshot.stopReason = requestedStop ?? "exit";
        if (requestedStop) snapshot.status = "stopped";
        else if (code === 0) snapshot.status = "stopped";
        else {
          snapshot.status = "failed";
          const tail = snapshot.diagnostics.trim().split(/\r?\n/).slice(-4).join(" | ") || snapshot.log.trim().split(/\r?\n/).slice(-4).join(" | ");
          snapshot.error = "QEMU 以退出码 " + code + " 结束" + (tail ? "：" + tail : "");
        }
        void settle();
      });
      this.job = { snapshot, child, done, stop };
      emit();
      return clone(snapshot);
    } catch (error) {
      if (tempDir) {
        if (!this.options.trashItem) error = new Error(String(error) + "；未配置回收站，私有临时文件保留：" + tempDir);
        else {
          try { await this.options.trashItem(tempDir); }
          catch (cleanupError) { error = new Error(String(error) + "；私有临时文件未清理：" + tempDir + "（" + String(cleanupError) + "）"); }
        }
      }
      const failed: SimulatorSnapshot = {
        id: randomUUID(), provider: "qemu.esp32c3", status: "failed", root, environment,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: null, pid: null,
        qemu: { executable, version }, argv: [], build: { recordSha256: "", inputHash: "", builtAt: "" },
        app: { path: "", sha256: "", size: 0 }, flash: { sha256: "", size: 0, bootloaderOffset: BOOTLOADER_OFFSET, partitionTableOffset: PARTITION_TABLE_OFFSET, partitions: [] },
        uart: "", diagnostics: "", log: "", error: error instanceof Error ? error.message : String(error),
      };
      this.emit(failed);
      throw error;
    }
  }

  /** Explicit stop: the promise resolves only after QEMU really exited and private files were moved aside. */
  async cancel() {
    const job = this.job;
    if (!job) return;
    job.stop("cancel");
    await job.done;
  }

  /** Project switch and app quit call this; it never leaves a QEMU process or private flash behind. */
  async dispose() { await this.cancel(); }
}

/** Host wiring exports one factory: the tool identity, fixed argv and lifecycle stay inside this module. */
export const createQemuSimulator = (options: QemuSimulatorOptions) => new QemuSimulatorService(options);

/**
 * Cross-end evidence record for the app-only deployment gate. The hard fields are `passed`,
 * `appSha256` (identical to the app payload used for the physical write) and `environment`;
 * `inputHash` is WorkspaceService.fingerprint() and only included when a build record provided it.
 * QEMU identity and the private flash digest live under `source` and must not replace appSha256.
 */
export interface SimulatorEvidence {
  version: 1;
  passed: boolean;
  appSha256: string;
  environment: string;
  inputHash?: string;
  recordedAt: string;
  source: {
    kind: "qemu.esp32c3"; qemuExecutable: string; qemuVersion: string;
    buildRecordSha256: string; qemuFlashSha256: string; qemuFlashBytes: number; appBytes: number;
    status: SimulatorStatus; stopReason?: SimulatorStopReason; pid: number | null;
  };
}

/** `passed` requires a real ROM banner on UART0 and a clean stop; a refused run or an early cancel is false. */
export function simulatorEvidence(snapshot: SimulatorSnapshot): SimulatorEvidence {
  const passed = snapshot.status === "stopped" && !snapshot.error && snapshot.uart.includes("ESP-ROM:esp32c3");
  // A passed record must carry the host's trusted input fingerprint; the integration gate may not drop it.
  if (passed && !/^[0-9a-f]{64}$/.test(snapshot.build.inputHash)) throw new Error("通过的证据缺少 WorkspaceService 输入指纹");
  return {
    version: 1,
    passed,
    appSha256: snapshot.app.sha256,
    environment: snapshot.environment,
    ...(snapshot.build.inputHash ? { inputHash: snapshot.build.inputHash } : {}),
    recordedAt: snapshot.endedAt ?? snapshot.startedAt,
    source: {
      kind: "qemu.esp32c3", qemuExecutable: snapshot.qemu.executable, qemuVersion: snapshot.qemu.version,
      buildRecordSha256: snapshot.build.recordSha256, qemuFlashSha256: snapshot.flash.sha256, qemuFlashBytes: snapshot.flash.size, appBytes: snapshot.app.size,
      status: snapshot.status, ...(snapshot.stopReason ? { stopReason: snapshot.stopReason } : {}), pid: snapshot.pid,
    },
  };
}
