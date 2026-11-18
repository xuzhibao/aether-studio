import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  FlashBackupMetadata, FlashBackupOptions, FlashBackupResult, FlashCapabilities, FlashDeviceInfo,
  FlashProgress, FlashRange, FlashRestorePlan, FlashRestorePrepareOptions, FlashRestoreResult,
  FlashSecurityInfo, FlashSnapshot,
} from "../shared/flash";

const ALIGN = 4096;
const MIN_CHUNK = 64 * 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const MIN_BAUD = 115200;
const PLAN_TTL_MS = 10 * 60 * 1000;
const LOG_LIMIT = 240;

export interface EsptoolCommand { executable: string; prefixArgs?: string[] }
export interface EsptoolRunOptions { signal?: AbortSignal; timeoutMs?: number; log?: (line: string) => void }

/** Thin seam over the esptool CLI so tests can drive a file-backed fake over the same argument surface. */
export interface EsptoolRunner {
  readonly command: EsptoolCommand;
  run(args: string[], options?: EsptoolRunOptions): Promise<string>;
}

const cancelled = () => Object.assign(new Error("操作已取消"), { name: "AbortError" });
export const isAbort = (error: unknown) => (error as { name?: string } | null)?.name === "AbortError";

/** Runs the real esptool executable. Never routed through a shell, so paths are plain arguments. */
export class CliEsptool implements EsptoolRunner {
  constructor(readonly command: EsptoolCommand) {}
  run(args: string[], options: EsptoolRunOptions = {}) {
    const { signal, timeoutMs = 300000, log } = options;
    const argv = [...(this.command.prefixArgs ?? []), ...args];
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(cancelled());
      const child = spawn(this.command.executable, argv, { shell: false, windowsHide: true, detached: process.platform !== "win32" });
      let stdout = ""; let stderr = ""; let settled = false;
      const max = 4 * 1024 * 1024;
      const kill = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
        else { try { process.kill(-child.pid, sig); } catch { /* already gone */ } }
      };
      const finish = (error: Error | null, text = "") => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(text);
      };
      const aborted = () => { kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 1200).unref?.(); finish(cancelled()); };
      const timer = setTimeout(() => { kill("SIGKILL"); finish(new Error("esptool 命令超时（" + args.join(" ") + "）")); }, timeoutMs);
      signal?.addEventListener("abort", aborted, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => { const text = chunk.toString(); stdout = (stdout + text).slice(-max); if (log) for (const line of text.split(/\r?\n/)) if (line.trim()) log(line); });
      child.stderr?.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr = (stderr + text).slice(-max); if (log) for (const line of text.split(/\r?\n/)) if (line.trim()) log(line); });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        const text = stdout + stderr;
        if (code === 0) return finish(null, text);
        const detail = text.trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n") || "退出码 " + code;
        finish(new Error("esptool 退出码 " + code + "：\n" + detail));
      });
    });
  }
}

export interface FlashServiceOptions {
  emit?: (snapshot: FlashSnapshot) => void;
  chooseSave?: (suggestedName: string) => Promise<string | null>;
  chooseOpen?: () => Promise<string | null>;
  /** Chunk workspace. The product default prefers the S: cache drive on Windows. */
  cacheRoot?: string;
  /** Opened project folder; a backup must never be written inside it. */
  workspaceRoot?: () => string | null;
  /** The serial monitor owns the COM port while connected. */
  serialBusy?: () => boolean;
}

interface PlanRecord extends FlashRestorePlan {
  createdAtMs: number;
  chunkSize: number;
  baudRate: number;
  retries: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (date = new Date()) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
const hex = (n: number) => "0x" + n.toString(16);
const normalizeMac = (value: string) => value.replace(/[^0-9a-f]/gi, "").toLowerCase();
const sameRange = (a: FlashRange, b: FlashRange) => a.offset === b.offset && a.size === b.size;
const inside = (root: string, target: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export function parseFlashId(text: string): Omit<FlashDeviceInfo, "port" | "esptoolVersion" | "detectedAt"> {
  const chips = /Chip is\s+(.+?)\s*(?:\r?\n|$)/.exec(text);
  const flash = /Detected flash size:\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB)/i.exec(text);
  if (!chips || !flash) throw new Error("无法从 esptool flash_id 输出识别芯片或 Flash 大小，已停止（不会按猜测尺寸操作）。");
  const chipLine = chips[1].trim();
  const chip = chipLine.split(/\s+/)[0];
  const revision = /revision\s+([^\s)]+)/i.exec(chipLine)?.[1] ?? "";
  const detail = chipLine.slice(chip.length).trim();
  const unit = flash[2].toUpperCase();
  const factor = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : 1024;
  const flashSizeBytes = Math.round(Number(flash[1]) * factor);
  const features = /Features:\s*(.+?)\s*(?:\r?\n|$)/.exec(text)?.[1].split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return {
    chip,
    detail,
    revision,
    flashSizeBytes,
    flashSizeLabel: `${flash[1]}${unit}`,
    flashManufacturerId: /Manufacturer:\s*(0x[0-9a-f]+)/i.exec(text)?.[1] ?? "",
    flashDeviceId: /Device:\s*(0x[0-9a-f]+)/i.exec(text)?.[1] ?? "",
    mac: /MAC:\s*([0-9a-f:]{11,17})/i.exec(text)?.[1] ?? "",
    features,
    crystal: /Crystal is\s*(\d+\s*MHz)/i.exec(text)?.[1] ?? "",
  };
}

export function parseSecurity(text: string): FlashSecurityInfo {
  const boot = /Secure Boot:\s*(Enabled|Disabled)/i.exec(text)?.[1].toLowerCase();
  const encryption = /Flash Encryption:\s*(Enabled|Disabled)/i.exec(text)?.[1].toLowerCase();
  const secureBootEnabled = boot ? boot === "enabled" : null;
  const flashEncryptionEnabled = encryption ? encryption === "enabled" : null;
  const checked = secureBootEnabled !== null && flashEncryptionEnabled !== null;
  return {
    checked, secureBootEnabled, flashEncryptionEnabled,
    note: checked ? "已用 esptool get_security_info 只读确认。" : "无法从 get_security_info 输出确认安全启动/Flash 加密状态。",
  };
}

export class FlashService {
  private snapshotState: FlashSnapshot;
  private controller: AbortController | null = null;
  private plan: PlanRecord | null = null;
  private capabilityCache: { executable: string; value: FlashCapabilities } | null = null;
  private versionCache = "";
  private lastReadOffset = 0;

  constructor(private esptool: EsptoolRunner, private options: FlashServiceOptions = {}) {
    const cacheDir = options.cacheRoot?.trim() || FlashService.defaultCacheRoot();
    this.snapshotState = { status: "idle", operation: null, progress: null, backup: null, restore: null, plan: null, error: "", log: [], cacheDir };
    this.options.cacheRoot = cacheDir;
  }

  static defaultCacheRoot() {
    const configured = process.env.AETHER_FLASH_CACHE?.trim();
    if (configured) return configured;
    if (process.platform === "win32") {
      try { if (existsSync("S:\\")) return "S:\\aether-flash-cache"; } catch { /* fall through */ }
    }
    return path.join(os.tmpdir(), "aether-flash-cache");
  }

  setEsptool(esptool: EsptoolRunner) { this.esptool = esptool; this.capabilityCache = null; this.versionCache = ""; }
  snapshot(): FlashSnapshot { return structuredClone(this.snapshotState); }
  busy() { return this.snapshotState.status !== "idle"; }

  private emit() { this.options.emit?.(this.snapshot()); }
  private log(line: string) {
    const text = line.trim();
    if (!text) return;
    this.snapshotState.log = [...this.snapshotState.log, text].slice(-LOG_LIMIT);
  }
  private progress(progress: FlashProgress) { this.snapshotState.progress = progress; this.emit(); }
  private reset(status: FlashSnapshot["status"], operation: FlashSnapshot["operation"]) {
    this.snapshotState = { ...this.snapshotState, status, operation, error: "", progress: null };
    this.emit();
  }
  private fail(message: string, failedOffset?: number) {
    this.snapshotState.status = "idle"; this.snapshotState.error = message;
    if (this.snapshotState.progress) {
      this.snapshotState.progress.phase = "failed";
      if (failedOffset !== undefined) this.snapshotState.progress.failedOffset = failedOffset;
    }
    this.emit();
  }
  private finish() {
    this.controller = null;
    if (this.snapshotState.status === "cancelling") this.snapshotState.status = "idle";
    this.emit();
  }

  private run(args: string[], signal: AbortSignal, timeoutMs?: number) {
    return this.esptool.run(args, { signal, timeoutMs, log: (line) => this.log(line) });
  }

  async version() {
    if (this.versionCache) return this.versionCache;
    const text = await this.esptool.run(["version"], { timeoutMs: 30000, log: (line) => this.log(line) });
    return (this.versionCache = /esptool(?:\.py)?\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? text.trim().split(/\r?\n/).pop()?.trim() ?? "");
  }

  async capabilities(): Promise<FlashCapabilities> {
    const executable = `${this.esptool.command.executable} ${(this.esptool.command.prefixArgs ?? []).join(" ")}`.trim();
    if (this.capabilityCache?.executable === executable) return this.capabilityCache.value;
    const help = await this.esptool.run(["--help"], { timeoutMs: 30000 });
    let writeHelp = "";
    try { writeHelp = await this.esptool.run(["write_flash", "--help"], { timeoutMs: 30000 }); } catch { /* unsupported write_flash */ }
    let securityHelp = "";
    try { securityHelp = await this.esptool.run(["get_security_info", "--help"], { timeoutMs: 30000 }); } catch { /* reported below */ }
    const value: FlashCapabilities = {
      version: await this.version(),
      readFlash: /\bread_flash\b/.test(help),
      writeFlash: /\bwrite_flash\b/.test(help),
      getSecurityInfo: /\bget_security_info\b/.test(help) || /\bget_security_info\b/.test(securityHelp),
      // v4.x keeps the image header only when flash_mode/flash_freq are omitted, which is what a raw restore needs.
      preservesImageHeaders: /--flash_mode\s*\{[^}]*\bkeep\b/.test(writeHelp) && /--flash_freq\s*\{[^}]*\bkeep\b/.test(writeHelp),
      verifyOption: /--verify\b/.test(writeHelp),
      help,
    };
    this.capabilityCache = { executable, value };
    return value;
  }

  async describeDevice(port: string, signal = new AbortController().signal): Promise<FlashDeviceInfo> {
    if (!port?.trim()) throw new Error("请先选择设备端口");
    this.assertPortFree();
    const text = await this.run(["--port", port.trim(), "flash_id"], signal, 90000);
    const parsed = parseFlashId(text);
    if (!Number.isFinite(parsed.flashSizeBytes) || parsed.flashSizeBytes <= 0) throw new Error("Flash 大小无效，已停止。");
    return { ...parsed, port: port.trim(), esptoolVersion: await this.version(), detectedAt: new Date().toISOString() };
  }

  async checkSecurity(port: string, capabilities: FlashCapabilities, signal: AbortSignal): Promise<FlashSecurityInfo> {
    if (!capabilities.getSecurityInfo) {
      return { checked: false, secureBootEnabled: null, flashEncryptionEnabled: null, note: "当前 esptool 不支持 get_security_info；无法确认设备是否受保护。" };
    }
    try { return parseSecurity(await this.run(["--port", port, "get_security_info"], signal, 90000)); }
    catch (error) {
      if (isAbort(error)) throw error;
      return { checked: false, secureBootEnabled: null, flashEncryptionEnabled: null, note: "读取安全信息失败：" + String((error as Error).message ?? error) };
    }
  }

  private validateCommon(port: string, chunkSize: number, baudRate: number, retries: number) {
    if (!port?.trim()) throw new Error("请先选择设备端口");
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK || chunkSize % ALIGN !== 0) throw new Error(`块大小必须是 ${MIN_CHUNK / 1024}–${MAX_CHUNK / 1024} KiB 之间的 4 KiB 倍数`);
    if (!Number.isInteger(baudRate) || baudRate < MIN_BAUD || baudRate > 921600) throw new Error("波特率必须在 115200–921600 之间");
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error("重试次数必须在 0–5 之间");
  }

  private assertPortFree() {
    if (this.options.serialBusy?.()) throw new Error("串口监视器正在占用该端口；请先断开连接再执行 Flash 操作。");
  }

  async chooseBackupPath(suggestedName: string) {
    if (!this.options.chooseSave) throw new Error("当前环境无法打开保存对话框");
    return this.options.chooseSave(suggestedName);
  }
  async chooseBackupFile() {
    if (!this.options.chooseOpen) throw new Error("当前环境无法打开文件对话框");
    return this.options.chooseOpen();
  }

  private assertOutputPath(outputPath: string) {
    if (!outputPath || !path.isAbsolute(outputPath)) throw new Error("备份保存位置必须是绝对路径");
    if (!/\.bin$/i.test(outputPath)) throw new Error("备份文件必须使用 .bin 扩展名");
    const roots = [this.options.workspaceRoot?.() ?? "", process.cwd()].filter(Boolean);
    for (const root of roots) if (inside(root, outputPath)) throw new Error("备份不能写入当前工程或应用目录；请选择工程之外的位置。");
  }

  private async makeRunDir(kind: string) {
    const root = this.options.cacheRoot!;
    const directory = path.join(root, `${kind}-${stamp()}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(directory, { recursive: true });
    this.snapshotState.cacheDir = directory;
    return directory;
  }

  private async readChunk(port: string, offset: number, size: number, baudRate: number, directory: string, signal: AbortSignal, retries: number) {
    let attempt = 0;
    let baud = baudRate;
    for (;;) {
      attempt++;
      this.lastReadOffset = offset;
      const target = path.join(directory, `read-${hex(offset)}-${attempt}.bin`);
      try {
        await this.run(["--port", port, "--baud", String(baud), "read_flash", hex(offset), String(size), target], signal, 300000);
        const stat = await fs.stat(target);
        if (stat.size !== size) throw new Error(`读回长度不符：期望 ${size}，实际 ${stat.size}`);
        return { path: target, attempts: attempt };
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw cancelled();
        if (attempt > retries) throw new Error(`读取偏移 ${hex(offset)}（${size} 字节）失败，已重试 ${retries} 次：${String((error as Error).message ?? error)}`);
        // High baud rates corrupt long reads on USB-JTAG boards; step the retry down instead of retrying blindly.
        const next = Math.max(MIN_BAUD, Math.floor(baud / 2));
        this.log(`[重试] 偏移 ${hex(offset)} 第 ${attempt} 次失败，降速 ${baud} → ${next} 后重试：${String((error as Error).message ?? error)}`);
        baud = next;
      }
    }
  }

  async startBackup(options: FlashBackupOptions): Promise<FlashBackupResult> {
    if (this.busy()) throw new Error("已有 Flash 操作正在进行");
    this.validateCommon(options.port, options.chunkSize, options.baudRate, options.retries);
    this.assertOutputPath(options.outputPath);
    this.assertPortFree();
    if (await fs.access(options.outputPath).then(() => true, () => false)) throw new Error("目标备份文件已存在，请选择新的保存位置（不会覆盖已有文件）。");
    if (await fs.access(options.outputPath + ".meta.json").then(() => true, () => false)) throw new Error("同名元数据文件已存在，请选择新的保存位置（不会覆盖已有文件）。");
    const controller = new AbortController();
    this.controller = controller;
    this.reset("backing-up", "backup");
    this.lastReadOffset = 0;
    this.snapshotState.backup = null; this.snapshotState.restore = null; this.snapshotState.plan = null;
    const signal = controller.signal;
    try {
      this.progress({ phase: "detecting", offset: 0, total: 0, chunkIndex: 0, chunkCount: 0, message: "正在读取设备信息…" });
      const device = await this.describeDevice(options.port, signal);
      if (device.flashSizeBytes % ALIGN !== 0) throw new Error("Flash 大小不是 4 KiB 的整数倍，已停止。");
      const cacheDir = await this.makeRunDir("backup");
      const total = device.flashSizeBytes;
      const chunkCount = Math.ceil(total / options.chunkSize);
      let retriesUsed = 0;
      const chunks: string[] = [];
      for (let index = 0; index < chunkCount; index++) {
        const offset = index * options.chunkSize;
        const size = Math.min(options.chunkSize, total - offset);
        this.progress({ phase: "reading", offset, total, chunkIndex: index, chunkCount, message: `读取 ${hex(offset)} · ${(size / 1024).toFixed(0)} KiB（${index + 1}/${chunkCount}）` });
        const chunk = await this.readChunk(options.port, offset, size, options.baudRate, cacheDir, signal, options.retries);
        retriesUsed += chunk.attempts - 1;
        chunks.push(chunk.path);
      }
      this.progress({ phase: "finalizing", offset: total, total, chunkIndex: chunkCount, chunkCount, message: "拼接分块并计算整片摘要…" });
      const imagePath = path.join(cacheDir, "image.bin");
      const hash = createHash("sha256");
      const handle = await fs.open(imagePath, "w");
      try {
        for (const chunk of chunks) {
          const bytes = await fs.readFile(chunk);
          hash.update(bytes);
          await handle.write(bytes);
        }
      } finally { await handle.close(); }
      const stat = await fs.stat(imagePath);
      if (stat.size !== total) throw new Error(`拼接结果长度 ${stat.size} 与 Flash 大小 ${total} 不一致，已停止。`);
      const head = await fs.readFile(imagePath);
      const sanity = { bootloaderMagic: head[0] === 0xe9, partitionMagic: head.length > 0x8001 && head[0x8000] === 0xaa && head[0x8001] === 0x50 };
      const sha256 = hash.digest("hex");
      const metadata: FlashBackupMetadata = {
        format: "aether-flash-backup", version: 1, createdAt: new Date().toISOString(),
        device: { chip: device.chip, revision: device.revision, flashSizeBytes: device.flashSizeBytes, flashSizeLabel: device.flashSizeLabel, flashManufacturerId: device.flashManufacturerId, flashDeviceId: device.flashDeviceId, mac: device.mac, features: device.features },
        fileLength: stat.size, sha256, chunkSize: options.chunkSize, chunkCount, esptoolVersion: device.esptoolVersion, sanity,
      };
      // The final file only appears after every chunk, the length and the digest are known.
      await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
      const temporary = path.join(path.dirname(options.outputPath), `.${path.basename(options.outputPath)}.${randomUUID().slice(0, 8)}.aether-partial`);
      await fs.copyFile(imagePath, temporary);
      if (await fs.access(options.outputPath).then(() => true, () => false)) throw new Error("目标备份文件在操作期间被创建，已取消写入。");
      await fs.rename(temporary, options.outputPath);
      const metadataPath = options.outputPath + ".meta.json";
      const metaTemp = `${metadataPath}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(metaTemp, JSON.stringify(metadata, null, 2));
      await fs.rename(metaTemp, metadataPath);
      const result: FlashBackupResult = { outputPath: options.outputPath, metadataPath, metadata, chunkAttempts: chunkCount + retriesUsed, retriesUsed, cacheDir };
      this.snapshotState.status = "idle"; this.snapshotState.operation = null; this.snapshotState.backup = result; this.snapshotState.error = "";
      this.progress({ phase: "done", offset: total, total, chunkIndex: chunkCount, chunkCount, message: "备份完成，已核对长度与摘要。" });
      this.emit();
      return result;
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        this.fail("备份已取消：未生成成功备份文件（临时分块保留在缓存目录）。");
        throw Object.assign(new Error("备份已取消，未生成成功备份文件。"), { name: "AbortError" });
      }
      this.fail("备份失败：" + String((error as Error).message ?? error), this.lastReadOffset);
      throw error;
    } finally { this.finish(); }
  }

  async readMetadata(backupPath: string): Promise<FlashBackupMetadata> {
    if (!backupPath) throw new Error("请选择备份文件");
    const metaPath = backupPath + ".meta.json";
    let raw: string;
    try { raw = await fs.readFile(metaPath, "utf8"); }
    catch { throw new Error("找不到备份的元数据文件 " + path.basename(metaPath) + "；无法核实长度、摘要与设备，已拒绝恢复。"); }
    let parsed: FlashBackupMetadata;
    try { parsed = JSON.parse(raw); } catch { throw new Error("备份元数据不是有效 JSON，已拒绝恢复。"); }
    const device = parsed?.device;
    if (parsed?.format !== "aether-flash-backup" || parsed.version !== 1 || !device || typeof device.chip !== "string" || !Number.isInteger(parsed.fileLength) || !/^[0-9a-f]{64}$/i.test(parsed.sha256)) {
      throw new Error("备份元数据字段不完整或格式不受支持，已拒绝恢复。");
    }
    return parsed;
  }

  private async hashFile(file: string) {
    const hash = createHash("sha256");
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    } finally { await handle.close(); }
    return hash.digest("hex");
  }

  async prepareRestore(options: FlashRestorePrepareOptions): Promise<FlashRestorePlan> {
    if (this.busy()) throw new Error("已有 Flash 操作正在进行");
    this.validateCommon(options.port, options.chunkSize, options.baudRate, options.retries);
    this.assertPortFree();
    if (!options.backupPath || !/\.bin$/i.test(options.backupPath)) throw new Error("备份文件必须是 .bin");
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    this.reset("restoring", "restore");
    this.lastReadOffset = 0;
    this.snapshotState.backup = null; this.snapshotState.restore = null; this.snapshotState.plan = null;
    try {
      this.progress({ phase: "detecting", offset: 0, total: 0, chunkIndex: 0, chunkCount: 0, message: "正在核实备份与设备…" });
      const metadata = await this.readMetadata(options.backupPath);
      const stat = await fs.stat(options.backupPath);
      const fileLength = stat.size === metadata.fileLength;
      const sha256 = fileLength ? (await this.hashFile(options.backupPath)) === metadata.sha256 : false;
      const capabilities = await this.capabilities();
      const device = await this.describeDevice(options.port, signal);
      const deviceMatch = device.chip === metadata.device.chip
        && device.flashSizeBytes === metadata.device.flashSizeBytes
        && (!metadata.device.flashManufacturerId || !device.flashManufacturerId || metadata.device.flashManufacturerId === device.flashManufacturerId)
        && (!metadata.device.flashDeviceId || !device.flashDeviceId || metadata.device.flashDeviceId === device.flashDeviceId)
        && (!metadata.device.mac || !device.mac || normalizeMac(metadata.device.mac) === normalizeMac(device.mac));
      const security = await this.checkSecurity(device.port, capabilities, signal);
      const securityClear = security.checked && security.secureBootEnabled === false && security.flashEncryptionEnabled === false;
      const warnings: string[] = [];
      if (!capabilities.writeFlash) warnings.push("当前 esptool 不支持 write_flash");
      if (!capabilities.preservesImageHeaders) warnings.push("当前 esptool 的 write_flash 不接受 --flash_mode keep / --flash_freq keep，无法保证 bootloader 头参数不被改写");
      if (!capabilities.verifyOption) warnings.push("当前 esptool 的 write_flash 不支持 --verify；仍会逐段读回核对");
      if (!deviceMatch) warnings.push("当前设备与备份记录不一致（芯片、Flash 容量、厂商/型号或 MAC）");
      if (!security.checked) warnings.push("无法确认安全启动/Flash 加密状态");
      const blocked = !fileLength ? "备份文件长度与元数据不一致"
        : !sha256 ? "备份文件 SHA-256 与元数据不一致"
        : !capabilities.readFlash ? "当前 esptool 不支持 read_flash"
        : !capabilities.writeFlash ? "当前 esptool 不支持 write_flash"
        : !capabilities.preservesImageHeaders ? "当前 esptool 无法在不改写镜像头的情况下写入"
        : !security.checked ? "无法只读确认设备未启用安全启动/Flash 加密；为避免把受保护设备写坏，已拒绝恢复"
        : security.secureBootEnabled || security.flashEncryptionEnabled ? "目标设备已启用安全启动或 Flash 加密；拒绝写入"
        : !deviceMatch ? "目标设备与备份记录不匹配；已拒绝盲写"
        : "";
      const plan: PlanRecord = {
        planId: randomUUID(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
        createdAtMs: Date.now(), chunkSize: options.chunkSize, baudRate: options.baudRate, retries: options.retries,
        port: options.port.trim(), backupPath: options.backupPath, metadata, device, security,
        verification: { fileLength, sha256, deviceMatch, securityClear },
        ranges: [], totalBytes: 0,
        confirmationPhrase: "恢复-" + (normalizeMac(metadata.device.mac).slice(-4) || planSuffix(randomUUID())).toUpperCase(),
        warnings, blocked,
      };
      if (!blocked) {
        const cacheDir = await this.makeRunDir("restore");
        const total = device.flashSizeBytes;
        const chunkCount = Math.ceil(total / options.chunkSize);
        const chunks: string[] = [];
        for (let index = 0; index < chunkCount; index++) {
          const offset = index * options.chunkSize;
          const size = Math.min(options.chunkSize, total - offset);
          this.progress({ phase: "comparing", offset, total, chunkIndex: index, chunkCount, message: `读取当前内容以比较差异 ${hex(offset)}（${index + 1}/${chunkCount}）` });
          chunks.push((await this.readChunk(options.port, offset, size, options.baudRate, cacheDir, signal, options.retries)).path);
        }
        const currentPath = path.join(cacheDir, "current.bin");
        const handle = await fs.open(currentPath, "w");
        try {
          for (const chunk of chunks) {
            const bytes = await fs.readFile(chunk);
            await handle.write(bytes);
          }
        } finally { await handle.close(); }
        const current = await fs.readFile(currentPath);
        const backup = await fs.readFile(options.backupPath);
        if (current.length !== backup.length) throw new Error("当前读取长度与备份长度不一致，已停止。");
        plan.ranges = diffRanges(backup, current, ALIGN);
        plan.totalBytes = plan.ranges.reduce((sum, range) => sum + range.size, 0);
      }
      this.plan = plan;
      this.snapshotState.status = "idle"; this.snapshotState.operation = null; this.snapshotState.plan = plan; this.snapshotState.error = "";
      this.progress({ phase: "done", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: plan.blocked ? "恢复被拒绝：" + plan.blocked : `比较完成：需要写入 ${plan.ranges.length} 段，共 ${plan.totalBytes} 字节。` });
      this.emit();
      return plan;
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        this.fail("恢复准备已取消：未写入任何数据。");
        throw Object.assign(new Error("恢复准备已取消，未写入任何数据。"), { name: "AbortError" });
      }
      this.fail("恢复准备失败：" + String((error as Error).message ?? error), this.lastReadOffset);
      throw error;
    } finally { this.finish(); }
  }

  async executeRestore(planId: string, confirmation: string): Promise<FlashRestoreResult> {
    if (this.busy()) throw new Error("已有 Flash 操作正在进行");
    const plan = this.plan;
    if (!plan || plan.planId !== planId) throw new Error("恢复计划已过期，请重新执行准备步骤。");
    if (plan.blocked) throw new Error("恢复被拒绝：" + plan.blocked);
    if (Date.now() - plan.createdAtMs > PLAN_TTL_MS) throw new Error("恢复计划已过期（超过 10 分钟），请重新执行准备步骤。");
    if (confirmation !== plan.confirmationPhrase) throw new Error("确认文字不匹配；未写入任何数据。");
    this.assertPortFree();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    this.reset("restoring", "restore");
    this.snapshotState.backup = null; this.snapshotState.restore = null;
    const cacheDir = await this.makeRunDir("restore-write");
    const written: (FlashRange & { verified: boolean })[] = [];
    const pending = () => plan.ranges.filter((range) => !written.some((entry) => entry.verified && sameRange(entry, range)));
    try {
      // Re-check identity right before writing: the plan may predate a board swap.
      this.progress({ phase: "detecting", offset: 0, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: "写入前再次核实设备…" });
      const device = await this.describeDevice(plan.port, signal);
      const sameDevice = device.chip === plan.device.chip && device.flashSizeBytes === plan.device.flashSizeBytes
        && (!plan.device.mac || !device.mac || normalizeMac(plan.device.mac) === normalizeMac(device.mac));
      if (!sameDevice) throw new Error("写入前设备身份与计划不一致，已拒绝写入。");
      const capabilities = await this.capabilities();
      const security = await this.checkSecurity(plan.port, capabilities, signal);
      if (!security.checked) throw new Error("写入前无法确认设备安全状态，已拒绝写入。");
      if (security.secureBootEnabled || security.flashEncryptionEnabled) throw new Error("写入前发现设备已启用安全启动或 Flash 加密，已拒绝写入。");
      if (plan.ranges.length === 0) {
        const result: FlashRestoreResult = { planId, status: "completed", writtenRanges: [], remainingRanges: [], readBackVerified: true, message: "设备当前内容已与备份逐段一致，无需写入。", cacheDir };
        this.snapshotState.restore = result; this.snapshotState.status = "idle"; this.snapshotState.operation = null;
        this.progress({ phase: "done", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: result.message });
        this.emit();
        return result;
      }
      const backup = await fs.readFile(plan.backupPath);
      for (let index = 0; index < plan.ranges.length; index++) {
        const range = plan.ranges[index];
        this.progress({ phase: "writing", offset: range.offset, total: plan.metadata.fileLength, chunkIndex: index, chunkCount: plan.ranges.length, message: `写入 ${hex(range.offset)} · ${(range.size / 1024).toFixed(1)} KiB（${index + 1}/${plan.ranges.length}）` });
        const slicePath = path.join(cacheDir, `write-${hex(range.offset)}.bin`);
        await fs.writeFile(slicePath, backup.subarray(range.offset, range.offset + range.size));
        // Record the attempt before writing: if it is interrupted, the range must still be reported.
        written.push({ ...range, verified: false });
        // Never pass --flash_mode / --flash_freq / --flash_size: esptool would rewrite the image header.
        await this.run(["--port", plan.port, "--baud", String(plan.baudRate), "write_flash", "--verify", hex(range.offset), slicePath], signal, 300000);
      }
      this.progress({ phase: "reading-back", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: "逐段读回原始字节核对…" });
      for (const range of written) {
        const verifyPath = path.join(cacheDir, `verify-${hex(range.offset)}.bin`);
        await this.run(["--port", plan.port, "--baud", String(plan.baudRate), "read_flash", hex(range.offset), String(range.size), verifyPath], signal, 300000);
        const expected = createHash("sha256").update(backup.subarray(range.offset, range.offset + range.size)).digest("hex");
        range.verified = expected === await this.hashFile(verifyPath);
        if (!range.verified) throw new Error(`读回校验失败：${hex(range.offset)} 与备份不一致，恢复未完成。`);
      }
      const result: FlashRestoreResult = { planId, status: "completed", writtenRanges: written, remainingRanges: [], readBackVerified: written.every((range) => range.verified), message: "恢复完成：写入范围已逐段读回并与备份一致。", cacheDir };
      this.snapshotState.restore = result; this.snapshotState.status = "idle"; this.snapshotState.operation = null;
      this.progress({ phase: "done", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: plan.ranges.length, chunkCount: plan.ranges.length, message: result.message });
      this.emit();
      return result;
    } catch (error) {
      const aborted = isAbort(error) || signal.aborted;
      // Never claim success: report exactly which ranges were attempted and what is left.
      const message = aborted
        ? `恢复已取消：已尝试写入 ${written.length} 段，未完成全部范围；设备可能处于部分写入状态。`
        : `恢复失败：${String((error as Error).message ?? error)}；已尝试写入 ${written.length} 段，恢复未完成。`;
      const result: FlashRestoreResult = { planId, status: aborted ? "cancelled" : "failed", writtenRanges: written, remainingRanges: pending(), readBackVerified: false, message, cacheDir };
      this.snapshotState.restore = result; this.snapshotState.status = "idle"; this.snapshotState.operation = null;
      this.snapshotState.error = message;
      const next = pending()[0];
      this.progress({ phase: aborted ? "cancelled" : "failed", offset: written.reduce((sum, range) => sum + range.size, 0), total: plan.metadata.fileLength, chunkIndex: written.length, chunkCount: plan.ranges.length, message, ...(next ? { failedOffset: next.offset } : {}) });
      this.emit();
      return result;
    } finally { this.finish(); }
  }

  async cancel() {
    if (!this.controller) return;
    this.snapshotState.status = "cancelling";
    this.emit();
    this.controller.abort();
  }

  /** A build/upload or monitor session can change the flash, so a prepared plan must not be reused. */
  invalidatePlan() {
    if (!this.plan) return;
    this.plan = null;
    if (this.snapshotState.plan) { this.snapshotState.plan = null; this.emit(); }
  }

  async dispose() { await this.cancel(); }
}

function planSuffix(id: string) { return id.replace(/-/g, "").slice(0, 4); }

/** 4 KiB aligned differences between two equal-length images, merged into contiguous ranges. */
export function diffRanges(expected: Buffer, actual: Buffer, align: number): FlashRange[] {
  if (expected.length !== actual.length) throw new Error("两个镜像长度不一致");
  const ranges: FlashRange[] = [];
  for (let offset = 0; offset < expected.length; offset += align) {
    const end = Math.min(offset + align, expected.length);
    if (expected.subarray(offset, end).equals(actual.subarray(offset, end))) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.offset + last.size === offset) last.size += end - offset;
    else ranges.push({ offset, size: end - offset });
  }
  return ranges;
}
