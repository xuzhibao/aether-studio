import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  bootloaderOffsetForChip, chipIdFromMcu, evaluatePreflight, parseImageHeader, parsePartitionTable, unsupportedPreflight,
  type EspPartitionTable, type EspPreflightAllow, type EspPreflightInput, type EspPreflightResult,
} from "../../shared/esp";
import { findEsptool, platformioCoreDir } from "./esptool";
import { readDeviceFacts } from "./inspect";
import { projectConfig } from "../plugins/platformio";
import { withPort } from "../portLease";
import type { ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";
import type { TaskSnapshot } from "../../shared/desktop";

export interface EspPreflightOptions {
  root: string;
  environment?: string;
  port: string;
  platformio: string;
  allow?: EspPreflightAllow;
  workspace: WorkspaceService;
  tools?: ToolService;
  signal?: AbortSignal;
}

type Section = [string, [string, unknown][]];
const option = (section: Section | undefined, key: string): string => {
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

/** The board manifest PlatformIO actually builds with, read from the installed platform. */
async function boardManifest(core: string, platformName: string, board: string) {
  const base = path.join(core, "platforms");
  const directories = await fs.readdir(base).catch(() => [] as string[]);
  const directory = directories.filter((name) => name === platformName || name.startsWith(platformName + "@")).sort().reverse()[0];
  if (!directory) return { manifest: null as Record<string, any> | null, error: "未安装 PlatformIO 平台 " + platformName };
  const file = path.join(base, directory, "boards", board + ".json");
  try { return { manifest: JSON.parse(await fs.readFile(file, "utf8")) as Record<string, any>, error: "" }; }
  catch { return { manifest: null, error: "找不到板卡清单：" + file }; }
}

/** boot_app0.bin ships with the Arduino framework, not with the project's build directory. */
async function bootApp0Path(core: string, buildDirectory: string): Promise<string | null> {
  const local = path.join(buildDirectory, "boot_app0.bin");
  if ((await fs.stat(local).catch(() => null))?.isFile()) return local;
  const packages = path.join(core, "packages");
  for (const name of (await fs.readdir(packages).catch(() => [] as string[])).filter((item) => item.startsWith("framework-arduinoespressif32"))) {
    const candidate = path.join(packages, name, "tools", "partitions", "boot_app0.bin");
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}

interface ImageFacts { exists: boolean; size: number; sha256: string; chipId: number | null; valid: boolean; error: string }
const MISSING: ImageFacts = { exists: false, size: 0, sha256: "", chipId: null, valid: false, error: "文件不存在" };

async function imageFacts(file: string): Promise<ImageFacts> {
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes) return { ...MISSING };
  const header = parseImageHeader(bytes);
  return { exists: true, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), chipId: header.header?.chipId ?? null, valid: !!header.header, error: header.error };
}

async function partitionFacts(file: string): Promise<{ exists: boolean; size: number; sha256: string; table: EspPartitionTable }> {
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes) return { exists: false, size: 0, sha256: "", table: { entries: [], valid: false, error: "文件不存在" } };
  return { exists: true, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), table: parsePartitionTable(bytes) };
}

/**
 * Reads the real build artifacts, the real board manifest and the real device, then evaluates the
 * write plan. Nothing is written; a blocking result means the upload task must not start.
 */
export async function preflightEspUpload(options: EspPreflightOptions): Promise<EspPreflightResult> {
  const { root, platformio, signal } = options;
  const port = options.port.trim();
  if (!port) return unsupportedPreflight("未选择端口", "", options.environment ?? "");

  let config: Section[];
  try { config = (await projectConfig(root, platformio)) as Section[]; }
  catch (error) { return unsupportedPreflight("无法解析 platformio.ini：" + String(error), port); }

  const envNames = config.filter(([name]) => name.startsWith("env:")).map(([name]) => name.slice(4));
  const defaults = config.find(([name]) => name === "platformio")?.[1].find(([name]) => name === "default_envs")?.[1];
  const defaultEnv = Array.isArray(defaults) && typeof defaults[0] === "string" ? defaults[0] : "";
  const environment = options.environment?.trim() || defaultEnv || envNames[0] || "";
  const section = config.find(([name]) => name === "env:" + environment);
  const platform = option(section, "platform");
  const platformName = platform.split("@")[0].trim();
  // Only ESP targets are protected; native and other PlatformIO projects keep their existing upload path.
  if (!section || platformName !== "espressif32") return unsupportedPreflight("工程目标平台不是 espressif32（" + (platform || "未声明") + "），跳过 ESP 预检", port, environment);

  const board = option(section, "board");
  const core = platformioCoreDir(options.tools);
  const { manifest, error: manifestError } = await boardManifest(core, platformName, board);
  const mcu = String(manifest?.build?.mcu ?? "");
  const expectedId = chipIdFromMcu(mcu);

  const uploadProtocol = option(section, "upload_protocol") || "esptool";
  const extraScripts = option(section, "extra_scripts");
  const unparseable = uploadProtocol !== "esptool"
    ? "platformio.ini 的 upload_protocol 是 " + uploadProtocol + "，不是标准 esptool 写入流程"
    : extraScripts ? "工程声明了 extra_scripts（" + extraScripts.slice(0, 120) + "），无法确认 upload 目标实际写入的段"
    : "";

  const buildDirectory = path.join(root, ".pio", "build", environment);
  const appOffsetText = option(section, "board_upload.offset_address");
  const appOffset = appOffsetText ? sizeBytes(appOffsetText) : sizeBytes(String(manifest?.upload?.offset_address ?? "")) ?? 0x10000;
  const appOffsetSource = appOffsetText
    ? "platformio.ini 的 board_upload.offset_address = " + appOffsetText
    : manifest?.upload?.offset_address ? "板卡清单 " + board + ".json 的 upload.offset_address" : "板卡清单未声明 upload.offset_address，使用 PlatformIO 默认 0x10000";
  const flashText = option(section, "board_upload.flash_size");
  const flashDeclared = sizeBytes(flashText) ?? sizeBytes(String(manifest?.upload?.flash_size ?? ""));
  const flashSource = flashText ? "platformio.ini 的 board_upload.flash_size" : "板卡清单 " + board + ".json 的 upload.flash_size";

  const [app, bootloader, partitions] = await Promise.all([
    imageFacts(path.join(buildDirectory, "firmware.bin")),
    imageFacts(path.join(buildDirectory, "bootloader.bin")),
    partitionFacts(path.join(buildDirectory, "partitions.bin")),
  ]);
  const bootApp0File = await bootApp0Path(core, buildDirectory);
  const bootApp0 = bootApp0File ? await imageFacts(bootApp0File) : null;
  const missing = [
    ...(app.exists ? [] : ["firmware.bin"]), ...(bootloader.exists ? [] : ["bootloader.bin"]), ...(partitions.exists ? [] : ["partitions.bin"]),
  ];

  // The plan is only trusted when it belongs to the build this app just recorded.
  let record: { environment?: string; inputHash?: string; artifacts?: { path: string; sha256: string }[] } | null = null;
  try { record = JSON.parse(await fs.readFile(path.join(root, ".aether", "build.json"), "utf8")); } catch { record = null; }
  const fingerprint = await options.workspace.fingerprint().catch(() => "");
  const recorded = new Map((record?.artifacts ?? []).map((artifact) => [path.basename(artifact.path), artifact.sha256]));
  const staleArtifacts = ([["firmware.bin", app], ["bootloader.bin", bootloader], ["partitions.bin", partitions]] as const)
    .filter(([name, facts]) => facts.exists && recorded.has(name) && recorded.get(name) !== facts.sha256).map(([name]) => name);
  const recordProblem = !record ? "没有找到 .aether/build.json 构建记录"
    : record.environment && record.environment !== environment ? "构建记录属于环境 " + record.environment + "，不是 " + environment
    : record.inputHash && fingerprint && record.inputHash !== fingerprint ? "构建完成后工程文件又发生了变化"
    : "";

  // Without the device chip the plan cannot be trusted either.
  const found = await findEsptool(options.tools);
  const device = found.tool
    ? await withPort(port, "ESP 部署预检", () => readDeviceFacts(found.tool!, port, signal))
    : { ok: false, error: found.reason, chip: null, flash: null, chipId: null, chipName: "", revision: "", flashSize: null, partitions: { entries: [], valid: false, error: "未读取" } as EspPartitionTable, security: null, notes: [] };

  const input: EspPreflightInput = {
    port, environment,
    chip: { expectedId, expectedMcu: mcu || board, expectedSource: "板卡清单 " + board + ".json 的 build.mcu", detectedId: device.chipId, detectedName: device.chipName, detectedRevision: device.revision },
    flash: { declared: flashDeclared, declaredSource: flashSource, detected: device.flashSize },
    images: {
      app: { file: "firmware.bin", size: app.size, sha256: app.sha256, chipId: app.chipId, valid: app.valid, error: app.error },
      bootloader: { file: "bootloader.bin", size: bootloader.size, sha256: bootloader.sha256, chipId: bootloader.chipId, valid: bootloader.valid },
      partitions: { file: "partitions.bin", size: partitions.size, sha256: partitions.sha256, entries: partitions.table.entries, valid: partitions.table.valid, error: partitions.table.error },
      bootApp0: bootApp0 ? { file: path.basename(bootApp0File!), size: bootApp0.size, sha256: bootApp0.sha256 } : null,
      missing,
    },
    layout: { appOffset, appOffsetSource, bootloaderOffset: bootloaderOffsetForChip(expectedId), partitionOffset: 0x8000, bootApp0Offset: 0xe000 },
    device: { ok: device.ok, error: device.error, partitions: device.partitions, security: device.security },
    upload: { protocol: uploadProtocol, parseable: !unparseable, reason: unparseable },
    allow: options.allow ?? {},
  };
  const result = evaluatePreflight(manifest ? input : {
    ...input,
    chip: { ...input.chip, expectedId: null, expectedSource: manifestError },
    upload: { ...input.upload, parseable: false, reason: manifestError },
  });

  // Build-record binding: the preview must describe the images that will actually be written.
  const extra: EspPreflightResult["findings"] = [];
  if (recordProblem) extra.push({ id: "build-record", severity: "block", title: "无法绑定到最近一次构建", detail: recordProblem + "；预检结果可能对应不上真正要写入的产物。", next: "在 Build Tasks 里重新构建当前环境，再点部署。" });
  if (staleArtifacts.length) extra.push({ id: "artifact-changed", severity: "block", title: "构建产物在构建后发生了变化", detail: "以下文件与构建记录中的 SHA-256 不一致：" + staleArtifacts.join("、") + "。", next: "重新构建当前环境后再部署，避免写入与预检不一致的镜像。" });
  return extra.length ? { ...result, ok: false, findings: [...result.findings, ...extra] } : result;
}

/** Task options carry the plan so the upload task can verify what esptool actually wrote. */
export const PLAN_OPTION = "espPlan";
export function encodePlan(segments: EspPreflightResult["segments"]): string {
  return JSON.stringify(segments.map((segment) => ({ name: segment.name, file: segment.file, offset: segment.offset, size: segment.size })));
}
