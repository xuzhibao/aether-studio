import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { deviceIdentityFrom, type EspDeviceFacts } from "./inspect";
import type { EspProjectFacts } from "./project";
import { runEsptool, type EsptoolTool } from "./esptool";
import type { EspFinding, EspPartitionEntry } from "../../shared/esp";

// Host-only "app-only" verification deploy.
//
// This mode writes exactly one app segment into the device OTA slot that the on-device bootloader
// will actually boot. It never rewrites the bootloader, the partition table, OTA metadata, phy_init,
// the model partition or ota_0, so it is only offered when every one of those facts is proven from
// the live device first. All checks are fail-closed: an unreadable/ambiguous OTA state, an unknown
// bootloader version or an app whose IDF version does not match the bootloader refuses the deploy
// before a process exists. It is not a general flashing path and it cannot be selected by the UI.

export const OTA_ENTRY_SIZE = 0x1000;
export const OTA_PARTITION_SIZE = 0x2000;
const SECTOR = 0x1000;

const ESP_OTA_IMG_INVALID = 3;
const ESP_OTA_IMG_ABORTED = 4;
const ESP_OTA_IMG_VALID = 2;
const ESP_OTA_IMG_UNDEFINED = 0xFFFFFFFF;

/** Standard CRC-32 (reflected, init 0xFFFFFFFF, final xor), equal to esp_rom_crc32_le(UINT32_MAX, ...). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  // Same value as esp_rom_crc32_le(UINT32_MAX, ...): zlib crc32 with a 0xFFFFFFFF input value,
  // which is what IDF v5.4 stores in ota_select_entry_t.crc (verified against the live board bytes).
  let crc = 0;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface EspOtaEntry {
  index: 0 | 1;
  seq: number;
  state: number;
  crc: number;
  crcComputed: number;
  crcValid: boolean;
  valid: boolean;
  slot: number | null;
}

export interface EspOtaSelection {
  entries: EspOtaEntry[];
  activeIndex: number;
  activeSeq: number;
  activeSlot: number;
  activeState: number;
  reason: string;
}

/**
 * Reads the two OTA select records exactly as IDF v5.4 does (bootloader_common_loader.c): the CRC
 * covers only ota_seq, validity rejects UNDEFINED/INVALID/ABORTED and a bad CRC, and the entry with
 * the larger seq wins. Any ambiguity is reported instead of guessed.
 */
export function parseOtaSelection(bytes: Uint8Array, appCount: number): EspOtaSelection {
  if (bytes.length < OTA_PARTITION_SIZE) throw new Error("OTA 记录长度不足（" + bytes.length + " 字节）");
  if (appCount < 1) throw new Error("设备分区表中没有 app 分区，无法确定 OTA 槽");
  const entries: EspOtaEntry[] = [0, 1].map((index) => {
    const base = index * OTA_ENTRY_SIZE;
    const view = new DataView(bytes.buffer, bytes.byteOffset + base, 32);
    const seq = view.getUint32(0, true);
    const state = view.getUint32(24, true);
    const crc = view.getUint32(28, true);
    const crcComputed = crc32(bytes.subarray(base, base + 4));
    const crcValid = crc === crcComputed;
    const valid = seq !== ESP_OTA_IMG_UNDEFINED && state !== ESP_OTA_IMG_INVALID && state !== ESP_OTA_IMG_ABORTED && crcValid;
    return { index: index as 0 | 1, seq, state, crc, crcComputed, crcValid, valid, slot: valid ? (seq - 1) % appCount : null };
  });
  const validEntries = entries.filter((entry) => entry.valid);
  if (!validEntries.length) throw new Error("两条 OTA 记录都无效（bootloader 会回退到默认槽，app-only 拒绝在未证明的槽上写入）");
  if (validEntries.some((entry) => entry.seq === 0)) throw new Error("OTA 记录出现 seq=0，IDF 不会生成该值，app-only 拒绝");
  const active = validEntries.reduce((best, entry) => (entry.seq > best.seq ? entry : best));
  if (validEntries.length === 2 && validEntries[0].seq === validEntries[1].seq) throw new Error("两条 OTA 记录 seq 相同，活动槽不唯一");
  if (validEntries.length === 2 && validEntries[0].seq === ESP_OTA_IMG_UNDEFINED) throw new Error("OTA 记录异常");
  if (active.slot === null) throw new Error("无法从 OTA 记录推导活动槽");
  return {
    entries, activeIndex: active.index, activeSeq: active.seq, activeSlot: active.slot, activeState: active.state,
    reason: "IDF v5.4: 取最大有效 seq；slot=(seq-1)%" + appCount,
  };
}

export interface EspIdfVersion { major: number; minor: number; patch: number; raw: string }

export function parseIdfVersion(text: string): EspIdfVersion | null {
  const match = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: match[3] ? Number(match[3]) : 0, raw: match[0] };
}

/** The bootloader image carries its own IDF version string near the start of the first segment. */
export function parseBootloaderVersion(head: Uint8Array): EspIdfVersion | null {
  for (const text of [new TextDecoder("ascii").decode(head.subarray(0x20, 0x60)), new TextDecoder("ascii").decode(head.subarray(0, 0x100))]) {
    const found = /v(\d+\.\d+(?:\.\d+)?)/.exec(text);
    if (found) return { ...parseIdfVersion(found[0])!, raw: found[0] };
  }
  return null;
}

export interface EspAppDescriptor { magicOk: boolean; projectName: string; version: string; idfVersion: string }

/** The app descriptor is at image offset 0x20 (ESP-IDF esp_app_desc_t); its idf_ver is what must fit the bootloader. */
export function parseAppDescriptor(image: Uint8Array): EspAppDescriptor {
  const empty = { magicOk: false, projectName: "", version: "", idfVersion: "" };
  if (image.length < 0x20 + 144) return empty;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const magicOk = view.getUint32(0x20, true) === 0xabcd5432;
  const text = (start: number, length: number) => new TextDecoder("utf-8").decode(image.subarray(start, start + length)).replace(/\0.*$/, "");
  return { magicOk, projectName: text(0x20 + 48, 32), version: text(0x20 + 16, 32), idfVersion: text(0x20 + 112, 32) };
}

/** The verification deploy only accepts an app built for the exact IDF major.minor of the bootloader. */
export function idfVersionsCompatible(bootloader: EspIdfVersion, app: EspIdfVersion): boolean {
  return bootloader.major === app.major && bootloader.minor === app.minor;
}

export interface EspAppOnlyTarget {
  partition: EspPartitionEntry;
  appOffset: number;
  appSize: number;
  appSha256: string;
  erase: { offset: number; size: number };
  otadata: EspOtaSelection;
  otadataOffset: number;
  otadataSha256: string;
  bootloaderVersion: EspIdfVersion;
  appIdfVersion: EspIdfVersion;
  partitionKey: string;
  chipType: string;
  findings: EspFinding[];
}

const partitionKey = (entries: EspPartitionEntry[]) => entries.map((entry) => [entry.type, entry.subtype, entry.offset, entry.size, entry.label].join(":")).sort().join("|");
const overlaps = (aStart: number, aSize: number, bStart: number, bSize: number) => aStart < bStart + bSize && bStart < aStart + aSize;
const hex = (value: number) => "0x" + value.toString(16).toUpperCase();

/** Binary-safe read helper: esptool writes the range to a file, which is read back and deleted. */
export async function readFlashRange(tool: EsptoolTool, port: string, offset: number, size: number, directory: string, name: string, signal?: AbortSignal): Promise<Uint8Array> {
  const file = directory + "/" + name;
  const run = await runEsptool(tool, ["--port", port, "read_flash", hex(offset), hex(size), file], { signal, timeoutMs: 120000 });
  if (run.cancelled) throw new Error("读取 " + hex(offset) + " 已取消");
  if (run.code !== 0) throw new Error("读取 " + hex(offset) + " 失败：" + (run.output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" / ") || "退出码 " + run.code));
  const bytes = await fs.readFile(file);
  await fs.rm(file, { force: true }).catch(() => {});
  if (bytes.length !== size) throw new Error("读取 " + hex(offset) + " 长度不符：" + bytes.length + " != " + size);
  return new Uint8Array(bytes);
}

export interface AppOnlyTargetOptions {
  tool: EsptoolTool; port: string; directory: string; signal?: AbortSignal;
  device: EspDeviceFacts; project: EspProjectFacts;
  appOffset: number; appSize: number; appSha256: string;
}

/**
 * Full identity check for app-only: OTA selection, target slot, containment, bootloader/app version
 * compatibility and the note that NVS may still be written by the firmware at runtime.
 */
export async function verifyAppOnlyTarget(options: AppOnlyTargetOptions): Promise<EspAppOnlyTarget> {
  const { tool, port, directory, device, project, signal } = options;
  if (!device.ok) throw new Error("无法读取设备：" + device.error);
  if (!device.partitions.valid) throw new Error("设备分区表不可读或无效：" + device.partitions.error);
  if (!device.security) throw new Error("无法确认 eFuse 安全状态（安全启动/flash 加密/下载模式），app-only 拒绝继续");
  if (device.security.secureBoot) throw new Error("设备已启用安全启动，未签名固件无法启动");
  if (device.security.flashEncryption) throw new Error("设备已启用 flash 加密，app-only 不支持");
  if (device.security.downloadModeDisabled) throw new Error("设备禁用了下载模式");
  if (!project.app.valid) throw new Error("app 镜像无效：" + project.app.error);

  const entries = device.partitions.entries;
  const appParts = entries.filter((entry) => entry.type === 0x00).sort((a, b) => a.offset - b.offset);
  if (!appParts.length) throw new Error("设备分区表中没有 app 分区");
  if (entries.some((entry) => entry.label === "factory")) throw new Error("设备存在 factory 分区，启动回退语义不同，app-only 不支持");
  const otaPart = entries.find((entry) => entry.type === 0x01 && entry.subtype === 0x00);
  if (!otaPart) throw new Error("设备没有 otadata 分区，无法证明启动槽");
  if (otaPart.size < OTA_PARTITION_SIZE) throw new Error("otadata 分区小于 0x2000 字节");

  const otaBytes = await readFlashRange(tool, port, otaPart.offset, OTA_PARTITION_SIZE, directory, "otadata.bin", signal);
  const selection = parseOtaSelection(otaBytes, appParts.length);
  if (selection.activeSlot < 0 || selection.activeSlot >= appParts.length) throw new Error("活动槽 " + selection.activeSlot + " 超出设备 app 分区数量 " + appParts.length);
  if (selection.activeState !== ESP_OTA_IMG_VALID) throw new Error("活动 OTA 记录状态是 " + selection.activeState + "，不是 VALID；启动过程可能改写 otadata，app-only 拒绝");
  if (selection.activeSlot === 0) throw new Error("当前活动槽是 ota_0；本任务不允许改写 ota_0，app-only 拒绝");

  const partition = appParts[selection.activeSlot];
  if (options.appOffset !== partition.offset) throw new Error("构建的 app 偏移 " + hex(options.appOffset) + " 不是当前活动槽 " + partition.label + " 的偏移 " + hex(partition.offset) + "；app-only 拒绝");
  if (options.appSize <= 0) throw new Error("app 大小为 0");
  if (options.appOffset % SECTOR) throw new Error("app 偏移未按 4KB 对齐");
  const eraseStart = Math.floor(options.appOffset / SECTOR) * SECTOR;
  const eraseEnd = Math.ceil((options.appOffset + options.appSize) / SECTOR) * SECTOR;
  if (eraseStart < partition.offset || eraseEnd > partition.offset + partition.size) throw new Error("app 写入/擦除范围 " + hex(eraseStart) + "–" + hex(eraseEnd) + " 不在活动槽 " + partition.label + "（" + hex(partition.offset) + "/" + hex(partition.size) + "）内");
  for (const entry of entries) {
    if (entry === partition) continue;
    if (overlaps(eraseStart, eraseEnd - eraseStart, entry.offset, entry.size)) throw new Error("app 擦除范围与分区 " + entry.label + "（" + hex(entry.offset) + "/" + hex(entry.size) + "）重叠，app-only 拒绝");
  }

  const bootHead = await readFlashRange(tool, port, 0x0, 0x100, directory, "bootloader-head.bin", signal);
  const bootloaderVersion = parseBootloaderVersion(bootHead);
  if (!bootloaderVersion) throw new Error("无法解析设备 bootloader 的 IDF 版本，app-only 拒绝");
  const appImage = new Uint8Array(await fs.readFile(project.buildDirectory + "/firmware.bin"));
  const appDesc = parseAppDescriptor(appImage);
  if (!appDesc.magicOk) throw new Error("firmware.bin 缺少 ESP-IDF app 描述符，app-only 拒绝");
  const appIdfVersion = parseIdfVersion(appDesc.idfVersion);
  if (!appIdfVersion) throw new Error("无法解析 app 的 IDF 版本（" + (appDesc.idfVersion || "空白") + "），app-only 拒绝");
  if (!idfVersionsCompatible(bootloaderVersion, appIdfVersion)) {
    throw new Error("app 由 IDF " + appIdfVersion.raw + " 构建，设备 bootloader 是 IDF " + bootloaderVersion.raw + "；版本不匹配，app-only 拒绝（不会用完整上传降级兜底）");
  }

  const findings: EspFinding[] = [
    {
      id: "app-only-nvs", severity: "warn", title: "运行期可能写 NVS（0x" + otaPart.offset.toString(16).toUpperCase() + " 之前的数据区）",
      detail: "app-only 只写 ota 槽内的 app，但固件运行后可能写 NVS 等数据分区。NVS 已在整片备份中，恢复方式见备份清单。",
      next: "审阅时确认是否接受运行期 NVS 变更；拒绝则需在固件侧禁用相关写入。",
    },
    {
      id: "app-only-derived-slot", severity: "info", title: "活动槽由 OTA 字节与 IDF v5.4 规则推导，不是实机启动日志",
      detail: "选中 " + partition.label + "@" + hex(partition.offset) + "，seq=" + selection.activeSeq + "，state=" + selection.activeState + "。",
      next: "D 的真实 monitor 阶段仍需用新会话/随机挑战证明运行，不可用上传退出码替代。",
    },
  ];
  return {
    partition, appOffset: options.appOffset, appSize: options.appSize, appSha256: options.appSha256.toLowerCase(),
    erase: { offset: eraseStart, size: eraseEnd - eraseStart }, otadata: selection,
    otadataOffset: otaPart.offset, otadataSha256: createHash("sha256").update(otaBytes).digest("hex"),
    bootloaderVersion, appIdfVersion, partitionKey: partitionKey(entries), chipType: device.chipName, findings,
  };
}

/**
 * Re-proves the live identity inside the same port lease, immediately before the write process is
 * allowed to exist: chip, partition table, OTA records and the final private app bytes must all still
 * equal what the plan was verified against.
 */
export async function reverifyAppOnlyTarget(options: {
  tool: EsptoolTool; port: string; directory: string; signal?: AbortSignal;
  target: EspAppOnlyTarget; appFile: string;
  /** Opaque board handle proved by the preview; the same board must still answer on this port. */
  expectedIdentity?: string;
}): Promise<void> {
  const { tool, port, directory, target, signal } = options;
  const id = await runEsptool(tool, ["--port", port, "flash_id"], { signal, timeoutMs: 90000 });
  if (id.code !== 0) throw new Error("写前复检：无法读取芯片（" + id.output.trim().split(/\r?\n/).slice(-2).join(" / ") + "）。未写入任何数据。");
  const detected = /Detecting chip type\.\.\.\s*(\S+)/.exec(id.output)?.[1] ?? "";
  if (detected.toUpperCase() !== target.chipType.toUpperCase()) throw new Error("写前复检：检测到芯片 " + (detected || "未知") + "，计划针对 " + target.chipType + "。未写入任何数据。");

  if (options.expectedIdentity !== undefined) {
    const seen = deviceIdentityFrom(id.output);
    if (!seen || seen !== options.expectedIdentity) throw new Error("写前复检：" + port + " 上的设备与预览时的不是同一块板。未写入任何数据。");
  }

  const table = await readFlashRange(tool, port, 0x8000, 0x1000, directory, "ptable-recheck.bin", signal);
  const reparsed = parseTableEntries(table);
  if (partitionKey(reparsed) !== target.partitionKey) throw new Error("写前复检：设备分区表已变化。未写入任何数据。");

  const ota = await readFlashRange(tool, port, target.otadataOffset, OTA_PARTITION_SIZE, directory, "otadata-recheck.bin", signal);
  const selected = parseOtaSelection(ota, reparsed.filter((entry) => entry.type === 0x00).length);
  if (selected.activeIndex !== target.otadata.activeIndex || selected.activeSeq !== target.otadata.activeSeq || selected.activeSlot !== target.otadata.activeSlot) {
    throw new Error("写前复检：活动 OTA 槽已变化（" + selected.activeSeq + "/slot " + selected.activeSlot + "）。未写入任何数据。");
  }
  if (selected.activeState !== ESP_OTA_IMG_VALID) throw new Error("写前复检：活动 OTA 状态不再是 VALID。未写入任何数据。");

  const bytes = await fs.readFile(options.appFile);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== target.appSha256) throw new Error("写前复检：私有 app 快照 SHA 已变化（" + sha + "）。未写入任何数据。");
  void directory;
}

/** Minimal parser so the recheck does not depend on the shared table parser's error shape. */
function parseTableEntries(bytes: Uint8Array): EspPartitionEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: EspPartitionEntry[] = [];
  for (let offset = 0; offset + 32 <= bytes.length; offset += 32) {
    if (view.getUint8(offset) !== 0xaa || view.getUint8(offset + 1) !== 0x50) break;
    const type = view.getUint8(offset + 2);
    const subtype = view.getUint8(offset + 3);
    const partOffset = view.getUint32(offset + 4, true);
    const size = view.getUint32(offset + 8, true);
    let label = "";
    for (let i = 0; i < 16; i++) { const code = view.getUint8(offset + 12 + i); if (code === 0) break; label += String.fromCharCode(code); }
    entries.push({ type, subtype, offset: partOffset, size, label, typeName: type === 0 ? "app" : "data", subtypeName: "", flags: 0 });
  }
  return entries;
}
