// Shared ESP32 contract: esptool output parsing, flash image/partition-table parsing, USB descriptor
// classification and the deploy preflight rules. Pure data and pure functions only — no filesystem,
// no child process. The desktop host gathers the facts; this module decides what is safe to write.

export interface EspChipInfo { id: number; key: string; name: string; family: string }

// Chip ids are read from the image header written by the linker/objcopy step (esptool's own table),
// never inferred from a board name. ESP32-C2/C6/H2/P4/C5 are listed for recognition only.
export const ESP_CHIPS: EspChipInfo[] = [
  { id: 0, key: "esp32", name: "ESP32", family: "ESP32" },
  { id: 2, key: "esp32s2", name: "ESP32-S2", family: "ESP32-S2" },
  { id: 5, key: "esp32c3", name: "ESP32-C3", family: "ESP32-C3" },
  { id: 9, key: "esp32s3", name: "ESP32-S3", family: "ESP32-S3" },
  { id: 12, key: "esp32c2", name: "ESP32-C2", family: "ESP32-C2" },
  { id: 13, key: "esp32c6", name: "ESP32-C6", family: "ESP32-C6" },
  { id: 16, key: "esp32h2", name: "ESP32-H2", family: "ESP32-H2" },
  { id: 18, key: "esp32p4", name: "ESP32-P4", family: "ESP32-P4" },
  { id: 23, key: "esp32c5", name: "ESP32-C5", family: "ESP32-C5" },
];
export const chipById = (id: number): EspChipInfo | null => ESP_CHIPS.find((chip) => chip.id === id) ?? null;
export const chipByKey = (key: string): EspChipInfo | null => ESP_CHIPS.find((chip) => chip.key === key.toLowerCase()) ?? null;
/** PlatformIO board manifests use `build.mcu` such as `esp32c3`; that value is the actual build target. */
export const chipIdFromMcu = (mcu: string): number | null => chipByKey(mcu.trim())?.id ?? null;
/** First-stage bootloader offset is fixed per chip family by the Espressif image layout. */
export const bootloaderOffsetForChip = (id: number | null): number | null => id === null ? null : (id === 0 || id === 2 ? 0x1000 : 0x0);

export interface EspUsbDescriptor { vendorId: string; productId: string; manufacturer: string; product: string }
export interface EspUsbClass { kind: "native-usb" | "usb-uart-bridge" | "unknown"; vendor: string; note: string }
const BRIDGE_VENDORS: Record<string, string> = {
  "10c4": "Silicon Labs CP210x", "1a86": "WCH CH34x/CH91xx", "0403": "FTDI", "067b": "Prolific PL2303", "2341": "Arduino", "1b4f": "SparkFun",
};
/** USB descriptors are reported by the OS; they identify the USB device, never the board model. */
export function classifyUsb(usb: EspUsbDescriptor | null): EspUsbClass {
  if (!usb || !usb.vendorId) return { kind: "unknown", vendor: "", note: "操作系统未报告 VID/PID；不能据此判断开发板型号。" };
  const vendor = usb.vendorId.toLowerCase().replace(/^0x/, "");
  const product = usb.productId.toLowerCase().replace(/^0x/, "");
  if (vendor === "303a") {
    const native = product === "1001" ? "USB-Serial/JTAG" : product === "1002" ? "USB CDC" : "Espressif USB";
    return { kind: "native-usb", vendor: "Espressif", note: native + "（原生 USB，不经过 USB-UART 桥）。板型仍未知。" };
  }
  const bridge = BRIDGE_VENDORS[vendor];
  if (bridge) return { kind: "usb-uart-bridge", vendor: bridge, note: bridge + " USB-UART 桥；板型仍未知。" };
  return { kind: "unknown", vendor: "VID " + usb.vendorId, note: "未识别的 USB 厂商 ID；板型仍未知。" };
}

// ---------------------------------------------------------------------------------------------
// esptool output (4.9 CLI text). Parsing is strict: an unparsed field stays null instead of guessing.
// ---------------------------------------------------------------------------------------------

export interface EspToolChipFacts { key: string; name: string; variant: string; revision: string; features: string[]; crystalMhz: number | null; usbMode: string }
export interface EspToolFlashFacts { size: number | null; manufacturer: string; device: string }
export interface EspToolParse { chip: EspToolChipFacts | null; flash: EspToolFlashFacts | null; macReported: boolean; errors: string[] }

const sizeToBytes = (value: string, unit: string) => Math.round(Number(value) * (unit.toUpperCase() === "MB" ? 1024 * 1024 : 1024));

/** `esptool.py flash_id`: chip, revision, features, crystal, flash manufacturer/device and size. */
export function parseFlashId(text: string): EspToolParse {
  const errors: string[] = [];
  let chip: EspToolChipFacts | null = null;
  const chipLine = /Chip is (ESP32(?:-[A-Z0-9]+)?)(?: \(([^)]+)\))? \(revision ([^)]+)\)/.exec(text) ?? /Chip is (ESP32(?:-[A-Z0-9]+)?)/.exec(text);
  if (chipLine) {
    const name = chipLine[1];
    const key = name.toLowerCase().replace(/-/g, "");
    if (!chipByKey(key)) errors.push("未识别的芯片型号：" + name);
    const crystal = /Crystal is (\d+)\s*MHz/.exec(text);
    chip = {
      key, name, variant: chipLine[2]?.trim() ?? "", revision: (chipLine[3] ?? "").trim(),
      features: /Features: (.+)/.exec(text)?.[1]?.split(/,/).map((item) => item.trim()).filter(Boolean) ?? [],
      crystalMhz: crystal ? Number(crystal[1]) : null,
      usbMode: /USB mode: (.+)/.exec(text)?.[1]?.trim() ?? "",
    };
  } else errors.push("esptool 输出中没有芯片型号");
  let flash: EspToolFlashFacts | null = null;
  const detected = /Detected flash size: ([\d.]+)\s*(MB|KB)/i.exec(text);
  if (detected) {
    flash = {
      size: sizeToBytes(detected[1], detected[2]),
      manufacturer: /Manufacturer: (?:0x)?([0-9a-fA-F]+)/.exec(text)?.[1] ?? "",
      device: /Device: (?:0x)?([0-9a-fA-F]+)/.exec(text)?.[1] ?? "",
    };
  } else errors.push("esptool 输出中没有 flash 容量");
  // The MAC is a hardware identifier; only its presence is reported, the value is never returned.
  return { chip, flash, macReported: /^MAC: /m.test(text), errors };
}

/** Readable diagnosis for the failures users actually hit with a USB-CDC/JTAG device. */
export function describeEsptoolFailure(text: string): string {
  if (/could not open port|PermissionError|Access is denied|拒绝访问|Serial port.*(busy|in use)|cannot open port/i.test(text)) return "端口被占用或无法打开。请关闭串口监视器、其他烧录工具后重试。";
  if (/No serial data received|Failed to connect|Timed out waiting for packet|A fatal error occurred: Failed to connect/i.test(text)) return "未收到芯片响应。请确认端口、按 BOOT 键进入下载模式，或更换 USB 线后重试。";
  if (/Wrong boot mode detected|boot mode/i.test(text)) return "芯片处于错误启动模式。请按住 BOOT 后复位再放开。";
  if (!text.trim()) return "esptool 没有输出";
  return text.trim().split(/\r?\n/).filter((line) => !/^(esptool\.py v|Serial port )/i.test(line)).slice(-3).join(" / ").slice(0, 400);
}

/** Read-only security posture from esptool get_security_info (stub-only, no PyYAML needed). */
export function parseSecurityInfo(text: string): EspSecurityFacts {
  const state = (name: string): boolean | null => {
    const line = text.split(/\r?\n/).find((item) => new RegExp("^\\s*" + name + "\\s*:", "i").test(item));
    if (!line) return null;
    const value = line.split(":").slice(1).join(":").trim().toLowerCase();
    if (value.includes("disable") || value === "false") return false;
    if (value.includes("enable") || value === "true") return true;
    return null;
  };
  return { secureBoot: state("Secure Boot"), flashEncryption: state("Flash Encryption"), downloadModeDisabled: state("Disable Download Mode"), source: "esptool get_security_info（只读，无需 PyYAML）" };
}

export interface EspSecurityFacts { secureBoot: boolean | null; flashEncryption: boolean | null; downloadModeDisabled: boolean | null; source: string }
const flagValue = (line: string | undefined): boolean | null => {
  if (!line) return null;
  if (/[=:]\s*True\b/i.test(line)) return true;
  if (/[=:]\s*False\b/i.test(line)) return false;
  return null;
};
/** `espefuse.py summary` is read-only; only the three flags that change flashing safety are kept. */
export function parseEfuseSummary(text: string): EspSecurityFacts {
  const line = (name: string) => text.split(/\r?\n/).find((item) => item.includes(name));
  const crypt = line("SPI_BOOT_CRYPT_CNT");
  let flashEncryption: boolean | null = null;
  if (crypt) {
    if (/Disable/i.test(crypt)) flashEncryption = false;
    else {
      const binary = /=\s*(0b[01]+)/.exec(crypt)?.[1];
      const decimal = /=\s*(\d+)\b/.exec(crypt)?.[1];
      if (binary) flashEncryption = Number.parseInt(binary.slice(2) || "0", 2) % 2 === 1;
      else if (decimal !== undefined) flashEncryption = Number(decimal) % 2 === 1;
    }
  }
  return { secureBoot: flagValue(line("SECURE_BOOT_EN")), flashEncryption, downloadModeDisabled: flagValue(line("DIS_DOWNLOAD_MODE")), source: "espefuse summary（只读）" };
}

// ---------------------------------------------------------------------------------------------
// Binary formats: ESP image header and the 32-byte partition table entries.
// ---------------------------------------------------------------------------------------------

export interface EspImageHeader { magic: number; segmentCount: number; flashMode: number; flashSizeFreq: number; entry: number; chipId: number; hashAppended: number }
/** Reads the 24-byte `esp_image_header_t` prefix; segment contents are never interpreted. */
export function parseImageHeader(bytes: Uint8Array): { header: EspImageHeader | null; error: string } {
  if (bytes.length < 24) return { header: null, error: "镜像小于 24 字节" };
  if (bytes[0] !== 0xe9) return { header: null, error: "镜像 magic 不是 0xE9（不是 ESP 应用镜像）" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    header: {
      magic: bytes[0], segmentCount: bytes[1], flashMode: bytes[2] & 0x0f, flashSizeFreq: (bytes[3] >> 4) & 0x0f,
      entry: view.getUint32(4, true), chipId: view.getUint16(12, true), hashAppended: bytes[23],
    },
    error: "",
  };
}

export const PARTITION_TYPE_APP = 0x00;
export const PARTITION_TYPE_DATA = 0x01;
const APP_SUBTYPES: Record<number, string> = { 0x00: "factory", 0x10: "ota_0", 0x11: "ota_1", 0x12: "ota_2", 0x13: "ota_3", 0x14: "ota_4", 0x15: "ota_5", 0x16: "ota_6", 0x17: "ota_7", 0x20: "test" };
const DATA_SUBTYPES: Record<number, string> = { 0x00: "ota", 0x01: "phy", 0x02: "nvs", 0x03: "coredump", 0x04: "nvs_keys", 0x05: "efuse", 0x06: "undefined", 0x80: "esphttpd", 0x81: "fat", 0x82: "spiffs", 0x83: "littlefs" };
export interface EspPartitionEntry { label: string; type: number; subtype: number; typeName: string; subtypeName: string; offset: number; size: number; flags: number }
export interface EspPartitionTable { entries: EspPartitionEntry[]; valid: boolean; error: string }

/** Partition table binary: 32-byte entries, magic 0xAA50, terminator 0xEBEB, erased flash is 0xFF. */
export function parsePartitionTable(bytes: Uint8Array): EspPartitionTable {
  const entries: EspPartitionEntry[] = [];
  const decoder = new TextDecoder();
  for (let at = 0; at + 32 <= bytes.length; at += 32) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 32);
    const magic = view.getUint16(0, true);
    if (magic === 0xebeb) return { entries, valid: true, error: "" };
    // On flash the magic is the byte pair AA 50, so a little-endian read yields 0x50AA.
    if (magic !== 0x50aa) {
      if (!entries.length) return { entries: [], valid: false, error: "0x" + at.toString(16).toUpperCase() + " 处没有分区表 magic 0xAA50" + (magic === 0xffff ? "（该区域为空白 flash）" : "") };
      return { entries, valid: true, error: "" };
    }
    const rawLabel = decoder.decode(bytes.subarray(at + 12, at + 28)).replace(/\0[\s\S]*$/, "");
    const entry: EspPartitionEntry = {
      label: rawLabel, type: bytes[at + 2], subtype: bytes[at + 3],
      typeName: bytes[at + 2] === PARTITION_TYPE_APP ? "app" : bytes[at + 2] === PARTITION_TYPE_DATA ? "data" : "0x" + bytes[at + 2].toString(16),
      subtypeName: (bytes[at + 2] === PARTITION_TYPE_APP ? APP_SUBTYPES : DATA_SUBTYPES)[bytes[at + 3]] ?? "0x" + bytes[at + 3].toString(16),
      offset: view.getUint32(4, true), size: view.getUint32(8, true), flags: view.getUint32(28, true),
    };
    if (entry.offset % 0x1000) return { entries, valid: false, error: "分区 " + entry.label + " 的偏移 0x" + entry.offset.toString(16) + " 不是 4KB 对齐" };
    if (entry.size % 0x1000) return { entries, valid: false, error: "分区 " + entry.label + " 的大小 0x" + entry.size.toString(16) + " 不是 4KB 对齐" };
    entries.push(entry);
  }
  return { entries, valid: entries.length > 0, error: entries.length ? "" : "分区表为空" };
}

// ---------------------------------------------------------------------------------------------
// Deploy preflight
// ---------------------------------------------------------------------------------------------

export type EspSeverity = "block" | "warn" | "info";
export interface EspFinding { id: string; severity: EspSeverity; title: string; detail: string; next: string }
export interface EspPlannedSegment { name: string; file: string; offset: number; size: number; sha256: string; chipId: number | null; source: string }
export interface EspRange { offset: number; size: number }
export interface EspPreflightInput {
  port: string;
  environment: string;
  /** `expectedId` comes from the board manifest the build actually targeted; never from its display name. */
  chip: { expectedId: number | null; expectedMcu: string; expectedSource: string; detectedId: number | null; detectedName: string; detectedRevision: string };
  flash: { declared: number | null; declaredSource: string; detected: number | null };
  images: {
    app: { file: string; size: number; sha256: string; chipId: number | null; valid: boolean; error: string };
    bootloader: { file: string; size: number; sha256: string; chipId: number | null; valid: boolean };
    partitions: { file: string; size: number; sha256: string; entries: EspPartitionEntry[]; valid: boolean; error: string };
    bootApp0: { file: string; size: number; sha256: string } | null;
    missing: string[];
  };
  layout: { appOffset: number | null; appOffsetSource: string; bootloaderOffset: number | null; partitionOffset: number; bootApp0Offset: number };
  device: { ok: boolean; error: string; partitions: EspPartitionTable | null; security: EspSecurityFacts | null };
  upload: { protocol: string; parseable: boolean; reason: string };
}
export interface EspPreflightResult {
  supported: boolean; skipped: string; ok: boolean;
  port: string; environment: string; checkedAt: string;
  chip: EspPreflightInput["chip"]; flash: EspPreflightInput["flash"];
  layout: EspPreflightInput["layout"];
  segments: EspPlannedSegment[];
  partitions: { device: EspPartitionEntry[]; build: EspPartitionEntry[]; changed: boolean; deviceError: string; buildError: string };
  upload: EspPreflightInput["upload"];
  /** Device partitions whose sectors this plan will overwrite; the host snapshots these ranges first. */
  coverage: Array<{ label: string; typeName: string; offset: number; size: number; range: EspRange }>;
  findings: EspFinding[];
}

const hex = (value: number) => "0x" + value.toString(16).toUpperCase().padStart(4, "0");
const overlaps = (aStart: number, aSize: number, bStart: number, bSize: number) => aStart < bStart + bSize && bStart < aStart + aSize;
const covers = (entries: EspPartitionEntry[], start: number, size: number) => entries.filter((entry) => overlaps(start, size, entry.offset, entry.size));
const tableKey = (entry: EspPartitionEntry) => `${entry.type}/${entry.subtype}/${entry.offset}/${entry.size}/${entry.label}`;
export const samePartitionTable = (a: EspPartitionEntry[], b: EspPartitionEntry[]) => a.length === b.length && a.map(tableKey).sort().join("|") === b.map(tableKey).sort().join("|");

/**
 * Decides whether the planned write is safe. Blocking findings have no automatic override except the two
 * explicit, per-deploy acknowledgements (`allow`), which never cover a chip mismatch or a bad image.
 */
export function evaluatePreflight(input: EspPreflightInput): EspPreflightResult {
  const findings: EspFinding[] = [];
  const block = (id: string, title: string, detail: string, next: string) => findings.push({ id, severity: "block", title, detail, next });
  const warn = (id: string, title: string, detail: string, next: string) => findings.push({ id, severity: "warn", title, detail, next });
  const info = (id: string, title: string, detail: string) => findings.push({ id, severity: "info", title, detail, next: "无需操作" });
  const { images, chip, flash, layout, device, upload } = input;
  const mcuChip = chip.expectedId === null ? null : chipById(chip.expectedId);
  const detectedChip = chip.detectedId === null ? null : chipById(chip.detectedId);

  // 1. The upload method itself: only a standard esptool plan can be verified.
  if (!upload.parseable) {
    block("upload-unverifiable", "无法确认实际写入计划", upload.reason, "改用标准 esptool 上传（platformio.ini 不要覆盖 upload_protocol，也不要给 upload 目标挂 extra_scripts），或按官方文档手动烧录。");
  }

  // 2. Build artifacts must exist and be images for the environment that was built.
  for (const name of images.missing) block("artifact-missing", "缺少构建产物 " + name, "环境 " + input.environment + " 的构建目录中没有 " + name + "。", "先在 Build Tasks 里构建该环境，再重新部署。");
  if (images.app.valid && images.app.chipId !== null && chip.expectedId !== null && images.app.chipId !== chip.expectedId) {
    block("artifact-chip-mismatch", "固件与选择的构建目标不一致", "firmware.bin 的镜像头芯片 ID 是 " + (chipById(images.app.chipId)?.name ?? String(images.app.chipId)) + "，而板卡清单声明的目标 " + chip.expectedMcu + " 是 " + (mcuChip?.name ?? String(chip.expectedId)) + "。", "这是一份旧环境的产物。请选择匹配的环境重新构建后再上传。");
  }
  if (images.bootloader.valid && images.bootloader.chipId !== null && chip.expectedId !== null && images.bootloader.chipId !== chip.expectedId) {
    block("bootloader-chip-mismatch", "引导程序与构建目标不一致", "bootloader.bin 的芯片 ID 与板卡清单目标不同，说明构建目录混用了其他芯片的产物。", "清理 .pio/build/" + input.environment + " 后完整重建。");
  }
  if (!images.app.valid) block("image-invalid", "固件镜像无效", images.app.error || "firmware.bin 不是有效的 ESP 应用镜像。", "重新构建该环境。");
  if (!images.partitions.valid) block("partition-table-invalid", "构建的分区表无效", images.partitions.error, "检查 platformio.ini 的 board_build.partitions 与 partitions.csv。");

  // 3. Device identity: the detected chip must be exactly the build target.
  if (!device.ok) block("device-unreadable", "无法读取设备", device.error || "esptool 未能读取芯片信息。", "确认端口未被占用、设备处于可下载状态后重试；未确认芯片前不会写入。");
  else if (chip.detectedId !== null && chip.expectedId !== null && chip.detectedId !== chip.expectedId) {
    block("chip-mismatch", "设备芯片与构建目标不匹配", "端口上检测到 " + (detectedChip?.name ?? chip.detectedName) + "（rev " + (chip.detectedRevision || "?") + "），但本次构建目标是 " + (mcuChip?.name ?? chip.expectedMcu) + "。按板卡名或旧任务推断会写坏设备，因此阻止写入。", "选择与该设备芯片匹配的构建环境，或改用正确的设备与端口。");
  } else if (chip.detectedId === null && device.ok) {
    block("chip-unidentified", "无法确认设备芯片", "esptool 读取成功但未给出可识别的芯片型号。", "更新 PlatformIO / esptool 后重试。");
  }

  // 4. Flash capacity.
  if (flash.declared !== null && flash.detected !== null && flash.declared > flash.detected) {
    block("flash-too-small", "构建声明容量大于设备实际容量", "声明 " + (flash.declared / 1048576) + " MB，设备实际 " + (flash.detected / 1048576) + " MB。", "把 board_upload.flash_size 改成设备真实容量，或改用匹配的板卡。");
  } else if (flash.declared !== null && flash.detected !== null && flash.declared < flash.detected) {
    info("flash-smaller", "构建容量小于设备容量", "声明 " + (flash.declared / 1048576) + " MB，设备 " + (flash.detected / 1048576) + " MB；只会使用前 " + (flash.declared / 1048576) + " MB，其余区域不会被写入。");
  }

  // 5. Planned segment layout: alignment and overlaps between the segments we are about to write.
  const segments: EspPlannedSegment[] = [];
  if (images.bootloader.valid && layout.bootloaderOffset !== null) segments.push({ name: "bootloader", file: images.bootloader.file, offset: layout.bootloaderOffset, size: images.bootloader.size, sha256: images.bootloader.sha256, chipId: images.bootloader.chipId, source: "Espressif 镜像布局：" + (mcuChip?.name ?? "") + (layout.bootloaderOffset === 0 ? " 从 0x0 启动" : " 从 0x1000 启动") });
  if (images.partitions.valid) segments.push({ name: "partitions", file: images.partitions.file, offset: layout.partitionOffset, size: images.partitions.size, sha256: images.partitions.sha256, chipId: null, source: "PlatformIO 固定写入 0x8000" });
  if (images.bootApp0) segments.push({ name: "boot_app0", file: images.bootApp0.file, offset: layout.bootApp0Offset, size: images.bootApp0.size, sha256: images.bootApp0.sha256, chipId: null, source: "Arduino 框架固定写入 0xE000" });
  if (images.app.valid && layout.appOffset !== null) segments.push({ name: "app", file: images.app.file, offset: layout.appOffset, size: images.app.size, sha256: images.app.sha256, chipId: images.app.chipId, source: layout.appOffsetSource });
  for (const segment of segments) {
    if (segment.offset % 0x1000) block("unaligned", segment.name + " 写入地址未对齐", hex(segment.offset) + " 不是 4KB 擦除对齐。", "检查板卡清单的 upload.offset_address 与 partitions.csv。");
    if (segment.size <= 0) block("empty-segment", segment.name + " 为空", segment.file + " 大小为 0。", "重新构建该环境。");
  }
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j];
    if (overlaps(a.offset, a.size, b.offset, b.size)) block("segment-overlap", "写入段互相重叠", a.name + " " + hex(a.offset) + "–" + hex(a.offset + a.size) + " 与 " + b.name + " " + hex(b.offset) + "–" + hex(b.offset + b.size) + " 重叠。", "检查 partitions.csv 与 board_upload.offset_address，避免多段写同一区域。");
  }

  // 6. The app must land inside an app partition of the table that is actually written.
  const buildTable = images.partitions.entries;
  if (images.partitions.valid && layout.appOffset !== null && images.app.valid) {
    const appEnd = layout.appOffset + images.app.size;
    const host = buildTable.find((entry) => layout.appOffset! >= entry.offset && layout.appOffset! < entry.offset + entry.size && entry.type === PARTITION_TYPE_APP);
    if (!host) {
      const victim = buildTable.find((entry) => overlaps(layout.appOffset!, images.app.size, entry.offset, entry.size));
      block("app-outside-table", "app 写入地址不属于任何 app 分区", "firmware.bin 计划写到 " + hex(layout.appOffset) + "（" + layout.appOffsetSource + "），但构建的分区表里没有覆盖该地址的 app 分区" + (victim ? "；该区域是 " + victim.typeName + " 分区 " + victim.label + "（" + hex(victim.offset) + "）" : "。") + " 这会覆盖数据分区或写到空白区域。", "把 app 写到分区表中的 app 分区：设置 board_upload.offset_address 与 partitions.csv 中 ota_0（或 factory）的偏移一致（16MB 厂商布局示例为 0x100000）。");
    } else if (appEnd > host.offset + host.size) {
      block("app-too-large", "固件超出 app 分区", "firmware.bin 结束于 " + hex(appEnd) + "，分区 " + host.label + " 只到 " + hex(host.offset + host.size) + "。", "增大 app 分区或减小固件后重新构建。");
    }
  }

  // 7. The app must never land on sectors the device currently uses for data.
  if (device.ok && device.partitions?.valid && layout.appOffset !== null && images.app.valid) {
    const appEnd = layout.appOffset + images.app.size;
    const data = device.partitions.entries.find((entry) => entry.type === PARTITION_TYPE_DATA && overlaps(layout.appOffset!, images.app.size, entry.offset, entry.size));
    if (data) {
      block("app-over-device-data", "app 会覆盖设备上的数据分区 " + data.label, "firmware.bin 计划写到 " + hex(layout.appOffset) + "–" + hex(appEnd) + "，而设备当前在该区域是 " + data.typeName + " 分区 " + data.label + "（" + hex(data.offset) + "/" + hex(data.size) + "）。用新的分区表重命名区域不能证明旧数据可以覆盖，因此阻止写入。", "让 partitions.csv 与设备现有布局一致，并把 board_upload.offset_address 指向设备的 app 分区（本机 16MB 布局为 0x100000）后重新构建。");
    }
  }

  // 8. Compare the table that will be written with the table currently on the device.
  const deviceTable = device.partitions;
  const buildChanged = deviceTable?.valid ? !samePartitionTable(deviceTable.entries, buildTable) : false;
  if (device.ok && deviceTable?.valid && buildChanged) {
    warn("partition-rewrite", "分区表与设备现有布局不同", "构建的分区表会替换设备上的分区定义（" + summarizeDiff(deviceTable.entries, buildTable) + "）。写入前宿主会按设备当前的分区表逐 4KB 区块读取并校验快照，快照失败则不会写入。", "写入后原有数据分区的映射会改变；需要时用 Flash 面板恢复被覆盖的区块。");
  } else if (device.ok && deviceTable && !deviceTable.valid && deviceTable.error.includes("空白")) {
    info("blank-table", "设备没有分区表", "0x8000 处是空白 flash，将写入构建的分区表。");
  }

  // 9. boot_app0 crosses otadata / phy_init on some vendor layouts: always surfaced, never silent.
  if (images.bootApp0 && device.ok && deviceTable?.valid) {
    const crossed = covers(deviceTable.entries, layout.bootApp0Offset, images.bootApp0.size).filter((entry) => !(entry.type === PARTITION_TYPE_DATA && entry.subtype === 0x00 && entry.offset === layout.bootApp0Offset && entry.size === images.bootApp0!.size));
    if (crossed.length) {
      const text = crossed.map((entry) => entry.label + " " + hex(entry.offset) + "/" + hex(entry.size)).join("、");
      warn("bootapp0-overlap", "boot_app0 会跨区覆盖现有分区", "PlatformIO 固定把 boot_app0.bin 写到 " + hex(layout.bootApp0Offset) + "，长度 " + hex(images.bootApp0.size) + "，会覆盖设备上的 " + text + "。写入前宿主会读取并逐块校验这些 4KB 区块，快照失败则不会写入。", "写入后 phy_init 的射频校准数据会由固件重新生成；其他被覆盖区块可用 Flash 面板恢复。");
    }
  }

  // 10. Security state makes a plain write unbootable or impossible.
  const security = device.security;
  if (device.ok && !security) {
    warn("security-unknown", "未读取 eFuse 安全状态", "无法确认设备是否启用安全启动或 flash 加密；espefuse.py 需要 PyYAML，工具包缺失时只能跳过。", "在 PlatformIO 的 Python 环境中安装 PyYAML 后重新检测，或手动确认设备未启用安全启动 / flash 加密。");
  }
  if (security) {
    if (security.secureBoot === true) block("secure-boot", "设备已启用安全启动", "安全启动已开启，未签名的固件无法启动。", "使用与设备密钥匹配的签名流程；Aether 本轮不提供签名烧录。");
    else if (security.flashEncryption === true) block("flash-encryption", "设备已启用 flash 加密", "flash 加密已开启，明文镜像写入后无法启动。", "使用加密镜像烧录流程；Aether 本轮不支持。");
    else if (security.downloadModeDisabled === true) block("download-mode-disabled", "设备禁用了下载模式", "DIS_DOWNLOAD_MODE 已烧写，设备不接受串口烧录。", "只能通过其他已授权的方式更新固件。");
  }

  // Every device partition the plan will touch, computed from the device's own table and exact bytes.
  const coverage: EspPreflightResult["coverage"] = [];
  if (device.ok && deviceTable?.valid) for (const segment of segments) {
    for (const entry of deviceTable.entries) {
      if (!overlaps(segment.offset, segment.size, entry.offset, entry.size)) continue;
      const start = Math.max(segment.offset, entry.offset);
      coverage.push({ label: entry.label, typeName: entry.typeName, offset: entry.offset, size: entry.size, range: { offset: start, size: Math.min(segment.offset + segment.size, entry.offset + entry.size) - start } });
    }
  }
  return {
    supported: true, skipped: "", ok: !findings.some((finding) => finding.severity === "block"), port: input.port, environment: input.environment, checkedAt: new Date().toISOString(),
    chip, flash, layout, segments, coverage,
    partitions: { device: deviceTable?.entries ?? [], build: buildTable, changed: buildChanged, deviceError: device.error || deviceTable?.error || "", buildError: images.partitions.error },
    upload, findings,
  };
}

function summarizeDiff(device: EspPartitionEntry[], build: EspPartitionEntry[]) {
  const labels = new Set([...device.map((entry) => entry.label), ...build.map((entry) => entry.label)]);
  const parts: string[] = [];
  for (const label of labels) {
    const a = device.find((entry) => entry.label === label);
    const b = build.find((entry) => entry.label === label);
    if (!a) parts.push("新增 " + label);
    else if (!b) parts.push("移除 " + label);
    else if (a.offset !== b.offset || a.size !== b.size || a.type !== b.type || a.subtype !== b.subtype) parts.push(label + " " + hex(a.offset) + "/" + hex(a.size) + " → " + hex(b.offset) + "/" + hex(b.size));
  }
  return parts.slice(0, 6).join("；") || "布局相同";
}

/** Result of the preflight when the project is not an ESP target: nothing is read and nothing is blocked. */
export function unsupportedPreflight(reason: string, port = "", environment = ""): EspPreflightResult {
  return {
    supported: false, skipped: reason, ok: true, port, environment, checkedAt: new Date().toISOString(),
    chip: { expectedId: null, expectedMcu: "", expectedSource: "", detectedId: null, detectedName: "", detectedRevision: "" },
    flash: { declared: null, declaredSource: "", detected: null },
    layout: { appOffset: null, appOffsetSource: "", bootloaderOffset: null, partitionOffset: 0x8000, bootApp0Offset: 0xe000 },
    segments: [], coverage: [], partitions: { device: [], build: [], changed: false, deviceError: "", buildError: "" },
    upload: { protocol: "", parseable: false, reason: "非 ESP 工程" }, findings: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Post-upload evidence: what esptool actually wrote, parsed from the verbose PlatformIO log.
// ---------------------------------------------------------------------------------------------

export interface EspUploadWrite { offset: number; file: string }
export interface EspUploadEvidence { parseable: boolean; writes: EspUploadWrite[]; verifiedHashes: number; command: string; error: string }

/** Parses the `write_flash` command PlatformIO printed in verbose mode. */
export function parseUploadCommand(log: string): EspUploadEvidence {
  const lines = log.split(/\r?\n/).filter((line) => line.includes("write_flash"));
  const line = lines[lines.length - 1]?.trim() ?? "";
  if (!line) return { parseable: false, writes: [], verifiedHashes: 0, command: "", error: "日志中没有 esptool write_flash 命令行" };
  // The host logs paths with spaces as quoted arguments; split on quotes so a temp path stays one token.
  const tokens = (line.match(/"[^"]*"|\S+/g) ?? []).map((token) => token.replace(/^"|"$/g, "")).filter(Boolean);
  const start = tokens.indexOf("write_flash");
  if (start < 0) return { parseable: false, writes: [], verifiedHashes: 0, command: line, error: "无法定位 write_flash" };
  const writes: EspUploadWrite[] = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) continue;
    if (/^0x[0-9a-f]+$/i.test(token) && tokens[i + 1] && !tokens[i + 1].startsWith("-") && !/^0x[0-9a-f]+$/i.test(tokens[i + 1])) {
      writes.push({ offset: Number.parseInt(token, 16), file: tokens[i + 1] });
      i++;
    }
  }
  return { parseable: writes.length > 0, writes, verifiedHashes: (log.match(/Hash of data verified/g) ?? []).length, command: line, error: writes.length ? "" : "write_flash 参数中没有可识别的地址/文件对" };
}

export interface EspUploadCheck { ok: boolean; problems: string[]; evidence: EspUploadEvidence }
/** The upload is only "verified" when the command that ran matches the plan that was preflighted. */
export function checkUploadAgainstPlan(log: string, segments: Array<Pick<EspPlannedSegment, "offset" | "file">>): EspUploadCheck {
  const evidence = parseUploadCommand(log);
  const problems: string[] = [];
  if (!evidence.parseable) problems.push(evidence.error);
  else {
    const base = (file: string) => file.split(/[\\/]/).pop() ?? file;
    const planned = new Map(segments.map((segment) => [segment.offset, base(segment.file)]));
    const actual = new Map(evidence.writes.map((write) => [write.offset, base(write.file)]));
    for (const [offset, file] of planned) if (!actual.has(offset)) problems.push("预检的 " + file + " @ " + hex(offset) + " 没有出现在实际写入命令中");
    for (const [offset, file] of actual) if (!planned.has(offset)) problems.push("实际写入多出 " + file + " @ " + hex(offset) + "，预检未覆盖");
  }
  if (evidence.verifiedHashes < segments.length) problems.push("esptool 只确认了 " + evidence.verifiedHashes + " 段哈希，预检计划为 " + segments.length + " 段");
  return { ok: problems.length === 0, problems, evidence };
}

// ---------------------------------------------------------------------------------------------
// Host <-> renderer payloads for read-only inspection.
// ---------------------------------------------------------------------------------------------

export interface EspInspectResult {
  port: string;
  usb: EspUsbDescriptor | null;
  usbClass: EspUsbClass;
  /** Board model is never inferred: the chip and the USB descriptor do not identify a board. */
  board: { model: "unknown"; note: string };
  chip: (EspToolChipFacts & { id: number | null; family: string }) | null;
  flash: EspToolFlashFacts | null;
  partitions: { entries: EspPartitionEntry[]; valid: boolean; error: string; readBytes: number };
  security: EspSecurityFacts | null;
  /** Non-fatal notes (skipped eFuse read, unparsed optional fields). */
  notes: string[];
  tool: { executable: string; version: string; source: string };
  readOnly: true;
  error: string;
  checkedAt: string;
  durationMs: number;
}
