import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bootloaderOffsetForChip, chipIdFromMcu, parseImageHeader, parsePartitionTable, type EspPartitionTable } from "../../shared/esp";
import { platformioCoreDir } from "./esptool";
import { projectConfig } from "../plugins/platformio";
import type { ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";

// Everything the ESP checks need to know about a PlatformIO project, read from the project itself:
// `platformio project config`, the installed platform's board manifest and the real build directory.
// Nothing here comes from the renderer, and nothing here writes.

export type Section = [string, [string, unknown][]];
export const option = (section: Section | undefined, key: string): string => {
  const entry = section?.[1].find(([name]) => name === key)?.[1];
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "number") return String(entry);
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0].trim();
  return "";
};
/** PlatformIO sizes appear as `4MB`, `16MB`, `0x1000000` or a decimal byte count. */
export function sizeBytes(text: string): number | null {
  if (!text) return null;
  const match = /^(0x[0-9a-f]+|\d+)\s*(B|KB|MB)?$/i.exec(text.trim());
  if (!match) return null;
  const base = parseInt(match[1], match[1].startsWith("0x") ? 16 : 10);
  const unit = (match[2] ?? "B").toUpperCase();
  return unit === "MB" ? base * 1024 * 1024 : unit === "KB" ? base * 1024 : base;
}
/** esptool accepts `80m`; board manifests store `80000000L`. */
export function flashFreq(text: string): string {
  const value = text.trim().replace(/L$/i, "");
  if (!value) return "";
  if (/^\d+$/.test(value)) return Number(value) % 1000000 === 0 ? String(Number(value) / 1000000) + "m" : value;
  return value;
}

export interface ImageFacts { exists: boolean; size: number; sha256: string; chipId: number | null; valid: boolean; error: string }
const MISSING: ImageFacts = { exists: false, size: 0, sha256: "", chipId: null, valid: false, error: "文件不存在" };
export async function imageFacts(file: string): Promise<ImageFacts> {
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes) return { ...MISSING };
  const header = parseImageHeader(bytes);
  return { exists: true, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), chipId: header.header?.chipId ?? null, valid: !!header.header, error: header.error };
}
export async function partitionFacts(file: string): Promise<{ exists: boolean; size: number; sha256: string; table: EspPartitionTable }> {
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes) return { exists: false, size: 0, sha256: "", table: { entries: [], valid: false, error: "文件不存在" } };
  return { exists: true, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), table: parsePartitionTable(bytes) };
}

/** The board manifest PlatformIO actually builds with, read from the installed platform. */
export async function boardManifest(core: string, platformName: string, board: string) {
  const base = path.join(core, "platforms");
  const directories = await fs.readdir(base).catch(() => [] as string[]);
  const directory = directories.filter((name) => name === platformName || name.startsWith(platformName + "@")).sort().reverse()[0];
  if (!directory) return { manifest: null as Record<string, any> | null, error: "未安装 PlatformIO 平台 " + platformName };
  const file = path.join(base, directory, "boards", board + ".json");
  try { return { manifest: JSON.parse(await fs.readFile(file, "utf8")) as Record<string, any>, error: "" }; }
  catch { return { manifest: null, error: "找不到板卡清单：" + file }; }
}

/** boot_app0.bin ships with the Arduino framework, not with the project's build directory. */
export async function bootApp0Path(core: string, buildDirectory: string): Promise<string | null> {
  const local = path.join(buildDirectory, "boot_app0.bin");
  if ((await fs.stat(local).catch(() => null))?.isFile()) return local;
  const packages = path.join(core, "packages");
  for (const name of (await fs.readdir(packages).catch(() => [] as string[])).filter((item) => item.startsWith("framework-arduinoespressif32"))) {
    const candidate = path.join(packages, name, "tools", "partitions", "boot_app0.bin");
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}

/** Exact esptool parameters PlatformIO would use for this environment, or null when anything is unknown. */
export interface EspWriteArgs { chip: string; baud: string; before: string; after: string; flashMode: string; flashFreq: string; flashSize: string }
export interface EspProjectFacts {
  supported: boolean; skipped: string;
  root: string; environment: string; platform: string; board: string;
  expectedId: number | null; mcu: string; mcuSource: string;
  appOffset: number | null; appOffsetSource: string; bootloaderOffset: number | null; partitionOffset: number; bootApp0Offset: number;
  flashDeclared: number | null; flashSource: string;
  app: ImageFacts; bootloader: ImageFacts; partitions: Awaited<ReturnType<typeof partitionFacts>>;
  bootApp0: { file: string; facts: ImageFacts } | null; missing: string[];
  uploadProtocol: string; unparseable: string;
  recordProblem: string; staleArtifacts: string[]; buildDirectory: string;
  writeArgs: EspWriteArgs | null; writeArgsProblem: string;
}

const SKIP = (reason: string, root: string, environment: string): EspProjectFacts => ({
  supported: false, skipped: reason, root, environment, platform: "", board: "", expectedId: null, mcu: "", mcuSource: "",
  appOffset: null, appOffsetSource: "", bootloaderOffset: null, partitionOffset: 0x8000, bootApp0Offset: 0xe000,
  flashDeclared: null, flashSource: "", app: { ...MISSING }, bootloader: { ...MISSING }, partitions: { exists: false, size: 0, sha256: "", table: { entries: [], valid: false, error: "未读取" } },
  bootApp0: null, missing: [], uploadProtocol: "", unparseable: "", recordProblem: "", staleArtifacts: [], buildDirectory: "", writeArgs: null, writeArgsProblem: "",
});

export async function readEspProject(root: string, requested: string | undefined, platformio: string, tools: ToolService | undefined, workspace: WorkspaceService): Promise<EspProjectFacts> {
  let config: Section[];
  try { config = (await projectConfig(root, platformio)) as Section[]; }
  catch (error) { return SKIP("无法解析 platformio.ini：" + String(error), root, requested ?? ""); }
  const envNames = config.filter(([name]) => name.startsWith("env:")).map(([name]) => name.slice(4));
  const defaults = config.find(([name]) => name === "platformio")?.[1].find(([name]) => name === "default_envs")?.[1];
  const defaultEnv = Array.isArray(defaults) && typeof defaults[0] === "string" ? defaults[0] : "";
  const environment = requested?.trim() || defaultEnv || envNames[0] || "";
  const section = config.find(([name]) => name === "env:" + environment);
  const platform = option(section, "platform");
  const platformRaw = platform.split("@")[0].trim();
  // pioarduino publishes current ESP-IDF through a platform URL; it is still the espressif32 target.
  const isEspressif = platformRaw === "espressif32" || /pioarduino\/platform-espressif32/i.test(platformRaw);
  const platformName = isEspressif ? "espressif32" : platformRaw;
  if (!section || !isEspressif) return SKIP("工程目标平台不是 espressif32（" + (platform || "未声明") + "）", root, environment);

  const board = option(section, "board");
  const core = platformioCoreDir(tools);
  const { manifest, error: manifestError } = await boardManifest(core, platformName, board);
  const mcu = String(manifest?.build?.mcu ?? "");
  const expectedId = chipIdFromMcu(mcu);
  const uploadProtocol = option(section, "upload_protocol") || "esptool";
  const extraScripts = option(section, "extra_scripts");
  const unparseable = uploadProtocol !== "esptool"
    ? "platformio.ini 的 upload_protocol 是 " + uploadProtocol + "，不是标准 esptool 写入流程"
    : extraScripts ? "工程声明了 extra_scripts（" + extraScripts.slice(0, 120) + "），无法确认 upload 目标实际写入的段"
    : manifest ? "" : manifestError;

  const buildDirectory = path.join(root, ".pio", "build", environment);
  const appOffsetText = option(section, "board_upload.offset_address");
  const appOffset = appOffsetText ? sizeBytes(appOffsetText) : sizeBytes(String(manifest?.upload?.offset_address ?? "")) ?? 0x10000;
  const appOffsetSource = appOffsetText ? "platformio.ini 的 board_upload.offset_address = " + appOffsetText
    : manifest?.upload?.offset_address ? "板卡清单 " + board + ".json 的 upload.offset_address" : "平台默认 0x10000（板卡清单未声明）";
  const flashText = option(section, "board_upload.flash_size");
  const flashDeclared = sizeBytes(flashText) ?? sizeBytes(String(manifest?.upload?.flash_size ?? ""));
  const flashSource = flashText ? "platformio.ini 的 board_upload.flash_size" : "板卡清单 " + board + ".json 的 upload.flash_size";

  const [app, bootloader, partitions] = await Promise.all([
    imageFacts(path.join(buildDirectory, "firmware.bin")),
    imageFacts(path.join(buildDirectory, "bootloader.bin")),
    partitionFacts(path.join(buildDirectory, "partitions.bin")),
  ]);
  // boot_app0 belongs to the Arduino framework only; an ESP-IDF build must never plan it at 0xE000.
  const framework = option(section, "framework");
  const bootApp0File = /arduino/i.test(framework) ? await bootApp0Path(core, buildDirectory) : null;
  const bootApp0 = bootApp0File ? { file: bootApp0File, facts: await imageFacts(bootApp0File) } : null;
  const missing = [...(app.exists ? [] : ["firmware.bin"]), ...(bootloader.exists ? [] : ["bootloader.bin"]), ...(partitions.exists ? [] : ["partitions.bin"])];

  // The plan is only trusted when it belongs to the build this app recorded.
  let record: { environment?: string; inputHash?: string; artifacts?: { path: string; sha256: string }[] } | null = null;
  try { record = JSON.parse(await fs.readFile(path.join(root, ".aether", "build.json"), "utf8")); } catch { record = null; }
  const fingerprint = await workspace.fingerprint().catch(() => "");
  const recorded = new Map((record?.artifacts ?? []).map((artifact) => [path.basename(artifact.path), artifact.sha256]));
  const staleArtifacts = ([["firmware.bin", app], ["bootloader.bin", bootloader], ["partitions.bin", partitions]] as const)
    .filter(([name, facts]) => facts.exists && recorded.has(name) && recorded.get(name) !== facts.sha256).map(([name]) => name);
  const recordProblem = !record ? "没有找到 .aether/build.json 构建记录"
    : record.environment && record.environment !== environment ? "构建记录属于环境 " + record.environment + "，不是 " + environment
    : record.inputHash && fingerprint && record.inputHash !== fingerprint ? "构建完成后工程文件又发生了变化"
    : "";

  const flashMode = option(section, "board_build.flash_mode") || String(manifest?.build?.flash_mode ?? "");
  const freq = flashFreq(option(section, "board_build.f_flash") || String(manifest?.build?.f_flash ?? ""));
  const size = flashText || String(manifest?.upload?.flash_size ?? "");
  const baud = option(section, "board_upload.speed") || String(manifest?.upload?.speed ?? "460800");
  const writeArgsProblem = [mcu ? "" : "板卡清单缺少 build.mcu", expectedId === null ? "无法识别 build.mcu 对应的芯片" : "", flashMode ? "" : "缺少 board_build.flash_mode", freq ? "" : "缺少 board_build.f_flash", size ? "" : "缺少 upload.flash_size"].filter(Boolean).join("；");
  const writeArgs: EspWriteArgs | null = writeArgsProblem ? null : {
    chip: mcu, baud, before: String(manifest?.upload?.before_reset ?? "default_reset"), after: String(manifest?.upload?.after_reset ?? "hard_reset"),
    flashMode, flashFreq: freq, flashSize: size,
  };

  return {
    supported: true, skipped: "", root, environment, platform, board, expectedId, mcu, mcuSource: "板卡清单 " + board + ".json 的 build.mcu",
    appOffset, appOffsetSource, bootloaderOffset: bootloaderOffsetForChip(expectedId), partitionOffset: 0x8000, bootApp0Offset: 0xe000,
    flashDeclared, flashSource, app, bootloader, partitions, bootApp0, missing,
    uploadProtocol, unparseable, recordProblem, staleArtifacts, buildDirectory,
    writeArgs, writeArgsProblem,
  };
}
