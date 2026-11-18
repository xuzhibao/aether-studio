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
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (date = new Date()) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
const hex = (n: number) => "0x" + n.toString(16);
const normalizeMac = (value: string) => (value ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
const sameRange = (a: FlashRange, b: FlashRange) => a.offset === b.offset && a.size === b.size;
const inside = (root: string, target: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const transientRename = (error: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");

interface IdentityRecord { chip: string; flashSizeBytes: number; flashManufacturerId?: string; flashDeviceId?: string; mac: string }
/**
 * A write needs a positive identity match. A missing MAC on either side is not "matching": it is unknown,
 * and unknown identity is only good enough for read-only work.
 */
export function deviceIdentityMatches(record: IdentityRecord, device: IdentityRecord) {
  if (!record.chip || !device.chip || record.chip !== device.chip) return false;
  if (!record.flashSizeBytes || record.flashSizeBytes !== device.flashSizeBytes) return false;
  if (record.flashManufacturerId && device.flashManufacturerId && record.flashManufacturerId !== device.flashManufacturerId) return false;
  if (record.flashDeviceId && device.flashDeviceId && record.flashDeviceId !== device.flashDeviceId) return false;
  const recordedMac = normalizeMac(record.mac); const currentMac = normalizeMac(device.mac);
  return !!recordedMac && !!currentMac && recordedMac === currentMac;
}

/** Runs the real esptool executable. Never routed through a shell, so paths are plain arguments. */
export class CliEsptool implements EsptoolRunner {
  constructor(readonly command: EsptoolCommand) {}
  run(args: string[], options: EsptoolRunOptions = {}) {
    const { signal, timeoutMs = 300000, log } = options;
    const argv = [...(this.command.prefixArgs ?? []), ...args];
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(cancelled());
      const child = spawn(this.command.executable, argv, {
        shell: false, windowsHide: true, detached: process.platform !== "win32",
        // v4.x reads these as defaults; pinning them to keep prevents a user environment from rewriting the image header.
        env: { ...process.env, ESPTOOL_FF: "keep", ESPTOOL_FM: "keep", ESPTOOL_FS: "keep" },
      });
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
  /** Opened project folder; a backup (or its cache) must never be written inside it. */
  workspaceRoot?: () => string | null;
  /** Application directory, so a default Documents path is not mistaken for it. */
  appRoot?: () => string | null;
  /** The serial monitor owns the COM port while connected. */
  serialBusy?: () => boolean;
  /** Shared port lease with the monitor and upload tasks; claim must be synchronous. */
  claim?: () => void;
  release?: () => void;
}

interface PlanRecord extends FlashRestorePlan {
  createdAtMs: number;
  chunkSize: number;
  baudRate: number;
  retries: number;
}

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
  private style: "underscore" | "hyphen" = "underscore";
  private claimed = false;
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

  private cmd(name: string) { return this.style === "hyphen" ? name.replace(/_/g, "-") : name; }
  private emit() { this.options.emit?.(this.snapshot()); }
  private log(line: string) {
    const text = line.trim();
    if (!text) return;
    this.snapshotState.log = [...this.snapshotState.log, text].slice(-LOG_LIMIT);
  }
  private progress(progress: FlashProgress) { this.snapshotState.progress = progress; this.emit(); }
  private reset(status: FlashSnapshot["status"], operation: FlashSnapshot["operation"]) {
    // Clear results in the same update: a new operation must never show the previous one's success.
    this.snapshotState = { ...this.snapshotState, status, operation, error: "", progress: null, backup: null, restore: null, plan: null };
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
  private claim() { if (this.claimed) return; this.options.claim?.(); this.claimed = true; }
  private releaseLease() { if (!this.claimed) return; this.claimed = false; this.options.release?.(); }
  private finish() {
    this.controller = null;
    if (this.snapshotState.status === "cancelling") this.snapshotState.status = "idle";
    this.releaseLease();
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
    // esptool 5 prints hyphenated command names; the underscore spellings are runtime aliases only.
    this.style = /\bwrite-flash\b/.test(help) && !/\bwrite_flash\b/.test(help) ? "hyphen" : "underscore";
    let writeHelp = "";
    try { writeHelp = await this.esptool.run([this.cmd("write_flash"), "--help"], { timeoutMs: 30000 }); } catch { /* unsupported write_flash */ }
    let securityHelp = "";
    try { securityHelp = await this.esptool.run([this.cmd("get_security_info"), "--help"], { timeoutMs: 30000 }); } catch { /* reported below */ }
    const value: FlashCapabilities = {
      version: await this.version(),
      readFlash: /\bread[_-]flash\b/.test(help),
      writeFlash: /\bwrite[_-]flash\b/.test(help),
      getSecurityInfo: /\bget[_-]security[_-]info\b/.test(help) || /\bget[_-]security[_-]info\b/.test(securityHelp),
      // v4/v5 keep the image header only when flash mode/freq are omitted, which is what a raw restore needs.
      preservesImageHeaders: /--flash[-_]mode\s*\{[^}]*\bkeep\b/.test(writeHelp) && /--flash[-_]freq\s*\{[^}]*\bkeep\b/.test(writeHelp),
      verifyOption: /--verify\b/.test(writeHelp),
      help,
    };
    this.capabilityCache = { executable, value };
    return value;
  }

  async describeDevice(port: string, signal = new AbortController().signal): Promise<FlashDeviceInfo> {
    if (!port?.trim()) throw new Error("请先选择设备端口");
    this.assertPortFree();
    if (!this.capabilityCache) await this.capabilities();
    const text = await this.run(["--port", port.trim(), this.cmd("flash_id")], signal, 90000);
    const parsed = parseFlashId(text);
    if (!Number.isFinite(parsed.flashSizeBytes) || parsed.flashSizeBytes <= 0) throw new Error("Flash 大小无效，已停止。");
    return { ...parsed, port: port.trim(), esptoolVersion: await this.version(), detectedAt: new Date().toISOString() };
  }

  /** Port-exclusive device read used by the panel; it occupies the port like any other flash operation. */
  async describeExclusive(port: string): Promise<FlashDeviceInfo> {
    if (this.busy()) throw new Error("已有 Flash 操作正在进行");
    this.claim();
    const controller = new AbortController();
    this.controller = controller;
    this.reset("detecting", null);
    try {
      const info = await this.describeDevice(port, controller.signal);
      this.snapshotState.status = "idle"; this.snapshotState.operation = null;
      this.progress({ phase: "done", offset: 0, total: 0, chunkIndex: 0, chunkCount: 0, message: `已读取 ${info.chip} · ${info.flashSizeLabel}` });
      this.emit();
      return info;
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) {
        this.fail("读取设备信息已取消。");
        throw Object.assign(new Error("读取设备信息已取消。"), { name: "AbortError" });
      }
      this.fail("读取设备信息失败：" + String((error as Error).message ?? error));
      throw error;
    } finally { this.finish(); }
  }

  async checkSecurity(port: string, capabilities: FlashCapabilities, signal: AbortSignal): Promise<FlashSecurityInfo> {
    if (!capabilities.getSecurityInfo) {
      return { checked: false, secureBootEnabled: null, flashEncryptionEnabled: null, note: "当前 esptool 不支持 get_security_info；无法确认设备是否受保护。" };
    }
    try { return parseSecurity(await this.run(["--port", port, this.cmd("get_security_info")], signal, 90000)); }
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

  private forbiddenRoots() {
    return [this.options.workspaceRoot?.(), this.options.appRoot?.()].filter((value): value is string => !!value);
  }

  private assertOutputPath(outputPath: string) {
    if (!outputPath || !path.isAbsolute(outputPath)) throw new Error("备份保存位置必须是绝对路径");
    if (!/\.bin$/i.test(outputPath)) throw new Error("备份文件必须使用 .bin 扩展名");
    for (const root of this.forbiddenRoots()) if (inside(root, outputPath)) throw new Error("备份不能写入当前工程或应用目录；请选择工程之外的位置。");
  }

  private assertCacheRoot() {
    const root = this.options.cacheRoot!;
    for (const forbidden of this.forbiddenRoots()) if (inside(forbidden, root)) throw new Error("Flash 缓存目录不能位于工程或应用目录内：" + root);
  }

  private async makeRunDir(kind: string) {
    this.assertCacheRoot();
    const directory = path.join(this.options.cacheRoot!, `${kind}-${stamp()}-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(directory, { recursive: true });
    this.snapshotState.cacheDir = directory;
    return directory;
  }

  async chooseBackupPath(suggestedName: string) {
    if (!this.options.chooseSave) throw new Error("当前环境无法打开保存对话框");
    return this.options.chooseSave(suggestedName);
  }
  async chooseBackupFile() {
    if (!this.options.chooseOpen) throw new Error("当前环境无法打开文件对话框");
    return this.options.chooseOpen();
  }

  private async readChunk(port: string, offset: number, size: number, baudRate: number, directory: string, signal: AbortSignal, retries: number) {
    let attempt = 0;
    let baud = baudRate;
    for (;;) {
      attempt++;
      this.lastReadOffset = offset;
      const target = path.join(directory, `read-${hex(offset)}-${attempt}.bin`);
      try {
        await this.run(["--port", port, "--baud", String(baud), this.cmd("read_flash"), hex(offset), String(size), target], signal, 300000);
        const stat = await fs.stat(target);
        if (stat.size !== size) throw new Error(`读回长度不符：期望 ${size}，实际 ${stat.size}`);
        return { path: target, attempts: attempt, baud };
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
    // Reserve the port synchronously, before any await, so the monitor or an upload cannot slip in.
    this.claim();
    const controller = new AbortController();
    this.controller = controller;
    this.lastReadOffset = 0;
    this.reset("backing-up", "backup");
    const signal = controller.signal;
    try {
      this.assertPortFree();
      if (await fs.access(options.outputPath).then(() => true, () => false)) throw new Error("目标备份文件已存在，请选择新的保存位置（不会覆盖已有文件）。");
      if (await fs.access(options.outputPath + ".meta.json").then(() => true, () => false)) throw new Error("同名元数据文件已存在，请选择新的保存位置（不会覆盖已有文件）。");
      this.progress({ phase: "detecting", offset: 0, total: 0, chunkIndex: 0, chunkCount: 0, message: "正在读取设备信息…" });
      const capabilities = await this.capabilities();
      if (!capabilities.readFlash) throw new Error("当前 esptool 不支持 read_flash，无法备份。");
      const device = await this.describeDevice(options.port, signal);
      if (device.flashSizeBytes % ALIGN !== 0) throw new Error("Flash 大小不是 4 KiB 的整数倍，已停止。");
      const cacheDir = await this.makeRunDir("backup");
      const total = device.flashSizeBytes;
      const chunkCount = Math.ceil(total / options.chunkSize);
      let retriesUsed = 0;
      let baud = options.baudRate;
      const chunks: string[] = [];
      for (let index = 0; index < chunkCount; index++) {
        const offset = index * options.chunkSize;
        const size = Math.min(options.chunkSize, total - offset);
        this.progress({ phase: "reading", offset, total, chunkIndex: index, chunkCount, message: `读取 ${hex(offset)} · ${(size / 1024).toFixed(0)} KiB（${index + 1}/${chunkCount}）` });
        const chunk = await this.readChunk(options.port, offset, size, baud, cacheDir, signal, options.retries);
        retriesUsed += chunk.attempts - 1;
        baud = chunk.baud;
        chunks.push(chunk.path);
      }
      if (signal.aborted) throw cancelled();
      this.progress({ phase: "finalizing", offset: total, total, chunkIndex: chunkCount, chunkCount, message: "拼接分块并计算整片摘要…" });
      const imagePath = path.join(cacheDir, "image.bin");
      const hash = createHash("sha256");
      const handle = await fs.open(imagePath, "w");
      try {
        for (const chunk of chunks) {
          if (signal.aborted) throw cancelled();
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
      if (signal.aborted) throw cancelled();
      if (await fs.access(options.outputPath).then(() => true, () => false)) throw new Error("目标备份文件在操作期间被创建，已取消写入。");
      if (await fs.access(options.outputPath + ".meta.json").then(() => true, () => false)) throw new Error("同名元数据文件在操作期间被创建，已取消写入。");
      await fs.rename(temporary, options.outputPath);
      // From here the image is published; a late cancel cannot turn a completed backup into "cancelled".
      const metadataPath = options.outputPath + ".meta.json";
      const metaTemp = `${metadataPath}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(metaTemp, JSON.stringify(metadata, null, 2));
      let renamed = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
        try { await fs.rename(metaTemp, metadataPath); renamed = true; }
        catch (error) { lastError = error; if (!transientRename(error) || attempt === 2) break; await wait(60); }
      }
      if (!renamed) throw new Error(`备份镜像已写入 ${options.outputPath}，但元数据登记失败，不能视为成功备份；临时元数据在 ${metaTemp}。原因：${String((lastError as Error)?.message ?? lastError)}`);
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
    const valid = parsed?.format === "aether-flash-backup" && parsed.version === 1
      && !!device && typeof device.chip === "string" && device.chip.trim().length > 0
      && typeof device.mac === "string"
      && Number.isInteger(device.flashSizeBytes) && device.flashSizeBytes > 0 && device.flashSizeBytes % ALIGN === 0
      && Number.isInteger(parsed.fileLength) && parsed.fileLength > 0 && parsed.fileLength % ALIGN === 0
      && /^[0-9a-f]{64}$/i.test(parsed.sha256);
    if (!valid) throw new Error("备份元数据字段不完整或格式不受支持（长度/容量必须为正的 4 KiB 倍数），已拒绝恢复。");
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
    if (!options.backupPath || !/\.bin$/i.test(options.backupPath)) throw new Error("备份文件必须是 .bin");
    this.assertPortFree();
    this.claim();
    const controller = new AbortController();
    this.controller = controller;
    this.lastReadOffset = 0;
    this.reset("restoring", "restore");
    const signal = controller.signal;
    try {
      this.progress({ phase: "detecting", offset: 0, total: 0, chunkIndex: 0, chunkCount: 0, message: "正在核实备份与设备…" });
      const metadata = await this.readMetadata(options.backupPath);
      const stat = await fs.stat(options.backupPath);
      const fileLength = stat.size === metadata.fileLength;
      const wholeImage = metadata.fileLength === metadata.device.flashSizeBytes && metadata.fileLength > 0 && metadata.fileLength % ALIGN === 0;
      const sha256 = fileLength ? (await this.hashFile(options.backupPath)) === metadata.sha256 : false;
      const capabilities = await this.capabilities();
      const device = await this.describeDevice(options.port, signal);
      const deviceMatch = deviceIdentityMatches(metadata.device, device);
      const security = await this.checkSecurity(device.port, capabilities, signal);
      const securityClear = security.checked && security.secureBootEnabled === false && security.flashEncryptionEnabled === false;
      const warnings: string[] = [];
      if (!wholeImage) warnings.push("备份长度与元数据记录的 Flash 容量不一致，不能当作整片备份");
      if (!capabilities.writeFlash) warnings.push("当前 esptool 不支持 write_flash");
      if (!capabilities.preservesImageHeaders) warnings.push("当前 esptool 的 write_flash 不接受 --flash_mode keep / --flash_freq keep，无法保证 bootloader 头参数不被改写");
      if (!capabilities.verifyOption) warnings.push("当前 esptool 的 write_flash 不支持 --verify；仍会逐段读回核对");
      if (!deviceMatch) warnings.push(normalizeMac(metadata.device.mac) && normalizeMac(device.mac) ? "当前设备与备份记录不一致（芯片、Flash 容量、厂商/型号或 MAC）" : "备份或设备缺少 MAC，无法证明是同一块设备");
      if (!security.checked) warnings.push("无法确认安全启动/Flash 加密状态");
      const blocked = !wholeImage ? "备份文件不是整片镜像：长度与元数据中的 Flash 容量不一致"
        : !fileLength ? "备份文件长度与元数据不一致"
        : !sha256 ? "备份文件 SHA-256 与元数据不一致"
        : !capabilities.readFlash ? "当前 esptool 不支持 read_flash"
        : !capabilities.writeFlash ? "当前 esptool 不支持 write_flash"
        : !capabilities.preservesImageHeaders ? "当前 esptool 无法在不改写镜像头的情况下写入"
        : !security.checked ? "无法只读确认设备未启用安全启动/Flash 加密；为避免把受保护设备写坏，已拒绝恢复"
        : security.secureBootEnabled || security.flashEncryptionEnabled ? "目标设备已启用安全启动或 Flash 加密；拒绝写入"
        : !deviceMatch ? "目标设备与备份记录不匹配或身份信息不足；已拒绝盲写"
        : "";
      const plan: PlanRecord = {
        planId: randomUUID(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
        createdAtMs: Date.now(), chunkSize: options.chunkSize, baudRate: options.baudRate, retries: options.retries,
        port: options.port.trim(), backupPath: options.backupPath, metadata, device, security,
        verification: { fileLength, sha256, deviceMatch, securityClear, wholeImage },
        ranges: [], totalBytes: 0,
        confirmationPhrase: "恢复-" + (normalizeMac(metadata.device.mac).slice(-4) || planSuffix(randomUUID())).toUpperCase(),
        warnings, blocked,
      };
      if (!blocked) {
        const cacheDir = await this.makeRunDir("restore");
        const total = device.flashSizeBytes;
        const chunkCount = Math.ceil(total / options.chunkSize);
        const chunks: string[] = [];
        let baud = options.baudRate;
        for (let index = 0; index < chunkCount; index++) {
          const offset = index * options.chunkSize;
          const size = Math.min(options.chunkSize, total - offset);
          this.progress({ phase: "comparing", offset, total, chunkIndex: index, chunkCount, message: `读取当前内容以比较差异 ${hex(offset)}（${index + 1}/${chunkCount}）` });
          const chunk = await this.readChunk(options.port, offset, size, baud, cacheDir, signal, options.retries);
          baud = chunk.baud;
          chunks.push(chunk.path);
        }
        if (signal.aborted) throw cancelled();
        const currentPath = path.join(cacheDir, "current.bin");
        const handle = await fs.open(currentPath, "w");
        try {
          for (const chunk of chunks) {
            if (signal.aborted) throw cancelled();
            await handle.write(await fs.readFile(chunk));
          }
        } finally { await handle.close(); }
        const current = await fs.readFile(currentPath);
        const backup = await fs.readFile(options.backupPath);
        if (signal.aborted) throw cancelled();
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
    this.claim();
    const controller = new AbortController();
    this.controller = controller;
    this.reset("restoring", "restore");
    const signal = controller.signal;
    let cacheDir = "";
    let currentRange: FlashRange | null = null;
    const written: (FlashRange & { verified: boolean })[] = [];
    const attempted = (range: FlashRange) => written.some((entry) => sameRange(entry, range));
    const pending = () => plan.ranges.filter((range) => !attempted(range));
    try {
      cacheDir = await this.makeRunDir("restore-write");
      // Re-check identity right before writing: the plan may predate a board swap.
      this.progress({ phase: "detecting", offset: 0, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: "写入前再次核实设备…" });
      const device = await this.describeDevice(plan.port, signal);
      if (!deviceIdentityMatches(plan.device, device)) throw new Error("写入前设备身份与计划不一致或身份信息不足，已拒绝写入。");
      const capabilities = await this.capabilities();
      if (!capabilities.writeFlash) throw new Error("写入前发现当前 esptool 不支持 write_flash，已拒绝写入。");
      if (!capabilities.preservesImageHeaders) throw new Error("写入前发现当前 esptool 无法保证不改写镜像头，已拒绝写入。");
      const security = await this.checkSecurity(plan.port, capabilities, signal);
      if (!security.checked) throw new Error("写入前无法确认设备安全状态，已拒绝写入。");
      if (security.secureBootEnabled || security.flashEncryptionEnabled) throw new Error("写入前发现设备已启用安全启动或 Flash 加密，已拒绝写入。");
      // The backup may have been replaced after prepare; verify the exact bytes we are about to write.
      const backup = await fs.readFile(plan.backupPath);
      const backupSha = createHash("sha256").update(backup).digest("hex");
      if (backup.length !== plan.metadata.fileLength || backupSha !== plan.metadata.sha256) {
        throw new Error("备份文件在准备后被修改或替换，与计划中的长度/SHA-256 不一致，已拒绝写入；请重新准备。");
      }
      if (plan.ranges.length === 0) {
        const result: FlashRestoreResult = {
          planId, status: "completed", writtenRanges: [], remainingRanges: [], readBackVerified: false,
          message: `准备阶段（${new Date(plan.createdAt).toLocaleString()}）比较显示设备与备份一致，本次未写入任何数据；未做新的整片读回。`,
          cacheDir,
        };
        this.snapshotState.restore = result; this.snapshotState.status = "idle"; this.snapshotState.operation = null;
        this.progress({ phase: "done", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: result.message });
        this.emit();
        return result;
      }
      let baud = plan.baudRate;
      for (let index = 0; index < plan.ranges.length; index++) {
        const range = plan.ranges[index];
        currentRange = range;
        this.progress({ phase: "writing", offset: range.offset, total: plan.metadata.fileLength, chunkIndex: index, chunkCount: plan.ranges.length, message: `写入 ${hex(range.offset)} · ${(range.size / 1024).toFixed(1)} KiB（${index + 1}/${plan.ranges.length}）` });
        const slicePath = path.join(cacheDir, `write-${hex(range.offset)}.bin`);
        await fs.writeFile(slicePath, backup.subarray(range.offset, range.offset + range.size));
        // Record the attempt before writing: if it is interrupted, the range must still be reported.
        written.push({ ...range, verified: false });
        const attempt = await this.writeRange(plan.port, range.offset, slicePath, baud, plan.retries, capabilities.verifyOption, signal);
        baud = attempt.baud;
      }
      this.progress({ phase: "reading-back", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: 0, chunkCount: 0, message: "逐段读回原始字节核对…" });
      currentRange = null;
      for (const range of written) {
        currentRange = range;
        const verify = await this.readChunk(plan.port, range.offset, range.size, baud, cacheDir, signal, plan.retries);
        baud = verify.baud;
        const expected = createHash("sha256").update(backup.subarray(range.offset, range.offset + range.size)).digest("hex");
        range.verified = expected === await this.hashFile(verify.path);
        if (!range.verified) throw new Error(`读回校验失败：${hex(range.offset)} 与备份不一致，恢复未完成。`);
      }
      const ranges = plan.ranges.map((range) => `${range.offset === 0 ? "0x0" : hex(range.offset)}+${range.size}`).join("，");
      const result: FlashRestoreResult = {
        planId, status: "completed", writtenRanges: written, remainingRanges: [], readBackVerified: true,
        message: `计划范围已写入并逐段读回一致（${ranges}）；未写入区域以准备阶段比较为准，若期间设备运行过请重新准备。`,
        cacheDir,
      };
      this.snapshotState.restore = result; this.snapshotState.status = "idle"; this.snapshotState.operation = null;
      this.progress({ phase: "done", offset: plan.metadata.fileLength, total: plan.metadata.fileLength, chunkIndex: plan.ranges.length, chunkCount: plan.ranges.length, message: result.message });
      this.emit();
      return result;
    } catch (error) {
      const aborted = isAbort(error) || signal.aborted;
      // Never claim success: report exactly which ranges were attempted and which were not reached.
      const message = aborted
        ? `恢复已取消：已尝试写入 ${written.length} 段，未完成全部范围；设备可能处于部分写入状态。`
        : `恢复失败：${String((error as Error).message ?? error)}；已尝试写入 ${written.length} 段，恢复未完成。`;
      const result: FlashRestoreResult = { planId, status: aborted ? "cancelled" : "failed", writtenRanges: written, remainingRanges: pending(), readBackVerified: false, message, cacheDir };
      this.snapshotState.restore = result; this.snapshotState.status = "idle"; this.snapshotState.operation = null;
      this.snapshotState.error = message;
      this.progress({ phase: aborted ? "cancelled" : "failed", offset: currentRange?.offset ?? 0, total: plan.metadata.fileLength, chunkIndex: written.length, chunkCount: plan.ranges.length, message, ...(currentRange ? { failedOffset: currentRange.offset } : {}) });
      this.emit();
      return result;
    } finally {
      // One plan is good for one write attempt: after success or an interruption the user must re-prepare.
      this.plan = null;
      if (this.snapshotState.plan) this.snapshotState.plan = null;
      this.finish();
    }
  }

  /** Writes one range with the user's retry budget; overwriting is idempotent, so a retry is safe. */
  private async writeRange(port: string, offset: number, slicePath: string, baudRate: number, retries: number, verify: boolean, signal: AbortSignal) {
    let attempt = 0;
    let baud = baudRate;
    for (;;) {
      attempt++;
      const args = ["--port", port, "--baud", String(baud), this.cmd("write_flash"), ...(verify ? ["--verify"] : []), hex(offset), slicePath];
      try { await this.run(args, signal, 300000); return { attempts: attempt, baud }; }
      catch (error) {
        if (isAbort(error) || signal.aborted) throw cancelled();
        if (attempt > retries) throw new Error(`写入偏移 ${hex(offset)} 失败，已重试 ${retries} 次：${String((error as Error).message ?? error)}`);
        const next = Math.max(MIN_BAUD, Math.floor(baud / 2));
        this.log(`[重试] 写入 ${hex(offset)} 第 ${attempt} 次失败，降速 ${baud} → ${next} 后重试：${String((error as Error).message ?? error)}`);
        baud = next;
      }
    }
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
