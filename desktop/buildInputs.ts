import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

/** The shape PlatformIO Core prints for `project config --json-output`. */
export type ProjectConfig = [string, [string, unknown][]][];

export interface PartitionInput {
  /** Where the path came from: the resolved env option or the board definition. */
  source: string;
  /** Project-relative path in POSIX form; null when the environment uses a platform built-in table. */
  path: string | null;
  sha256: string | null;
  /** Built-in tables live inside the installed platform, so only the ini/board pin identifies them. */
  kind: "file" | "builtin";
}

export interface BuildInputSignature {
  format: 1;
  root: string;
  environment: string;
  iniSha256: string;
  partitions: PartitionInput[];
}

export interface BuildInputRecord {
  fingerprint: string;
  signature: BuildInputSignature;
  recordedAt: string;
}

interface BuildInputRecords { format: 1; environments: Record<string, BuildInputRecord> }

export interface InvalidationResult {
  reason: "unchanged" | "no-cache" | "config-changed" | "unknown-cache";
  moved: string[];
  note: string;
}

const recordFile = path.join(".aether", "build-config.json");
const staleRoot = path.join(".pio", "build", ".aether-stale");
// Only files whose content depends on the partition layout are moved aside; object files and
// dependency data stay, so the next PlatformIO run is still incremental.
const partitionArtifacts = ["partitions.bin", "partitions.csv", "bootloader.bin", "firmware.bin", "firmware.elf", "firmware.map"];

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const missing = (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error);

function sectionMap(config: ProjectConfig) {
  const sections = new Map<string, Record<string, unknown>>();
  for (const [name, entries] of config) {
    if (!Array.isArray(entries)) continue;
    const values: Record<string, unknown> = {};
    for (const entry of entries) if (Array.isArray(entry) && typeof entry[0] === "string") values[entry[0]] = entry[1];
    sections.set(name, values);
  }
  return sections;
}

function extendsList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** Merge `[env]`, the `extends` chain and `[env:<name>]` the way PlatformIO resolves option values. */
function resolveEnvironmentOptions(sections: Map<string, Record<string, unknown>>, environment: string, seen = new Set<string>()): Record<string, unknown> {
  const section = sections.get("env:" + environment);
  if (!section) throw new Error("platformio.ini 中没有环境：" + environment);
  if (seen.has(environment)) throw new Error("platformio.ini 的 extends 出现循环：" + [...seen, environment].join(" → "));
  seen.add(environment);
  let inherited: Record<string, unknown> = { ...(sections.get("env") ?? {}) };
  for (const reference of extendsList(section.extends)) {
    const name = reference.startsWith("env:") ? reference.slice(4) : reference;
    inherited = { ...inherited, ...resolveEnvironmentOptions(sections, name, new Set(seen)) };
  }
  return { ...inherited, ...section };
}

/** PlatformIO resolves relative partition tables against the project directory. */
function projectRelative(root: string, value: string) {
  const expanded = value.replace(/\$\{PROJECT_DIR\}/gi, () => root).replace(/^"|"$/g, "").trim();
  if (!expanded) throw new Error("board_build.partitions 为空");
  if (/\$\{[^}]+\}/.test(expanded)) throw new Error("无法解析分区表路径中的插值：" + value + "。请在 platformio.ini 中使用工程内的字面路径。");
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(root, expanded);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("分区表必须位于工程目录内：" + value);
  return relative.split(path.sep).join("/");
}

/** A path is only touched when every component below the project root is a plain file/directory. */
async function assertPlainPath(root: string, relative: string) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("不通过链接读取分区表：" + relative);
  }
}

/**
 * The active partition table of one environment: the env option wins over the board definition.
 * Built-in table names ("default") are recorded by name; the installed platform pin in the ini covers them.
 */
export async function resolvePartitionInputs(root: string, config: ProjectConfig, environment: string): Promise<PartitionInput[]> {
  const sections = sectionMap(config);
  const options = resolveEnvironmentOptions(sections, environment);
  const board = typeof options.board === "string" ? options.board : "";
  const boardOptions = board ? sections.get("board:" + board) : undefined;
  const declared = options["board_build.partitions"];
  const source = declared !== undefined ? "env:" + environment : board ? "board:" + board : "platform";
  const value = declared ?? boardOptions?.["board_build.partitions"];
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error("board_build.partitions 必须是字符串：" + JSON.stringify(value));
  if (/^(default|default\.csv)$/i.test(value.trim())) return [{ source, path: null, sha256: null, kind: "builtin" }];
  const relative = projectRelative(root, value);
  await assertPlainPath(root, relative);
  const buffer = await fs.readFile(path.join(root, relative)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("找不到 platformio.ini 指定的分区表：" + relative);
    throw error;
  });
  return [{ source, path: relative, sha256: sha256(buffer), kind: "file" }];
}

export function signatureFor(root: string, environment: string, iniText: string, partitions: PartitionInput[]): BuildInputSignature {
  return { format: 1, root, environment, iniSha256: sha256(iniText), partitions };
}

/** Stable fingerprint: the fields are created in a fixed order, so JSON text is deterministic. */
export const fingerprintOf = (signature: BuildInputSignature) => sha256(JSON.stringify(signature));

async function readRecords(root: string): Promise<BuildInputRecords> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(root, recordFile), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, environments: {} };
    // A damaged record is treated like a missing one: the next build re-checks the cache instead of trusting it.
    return { format: 1, environments: {} };
  }
  const environments = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { environments?: unknown }).environments : undefined;
  if (!environments || typeof environments !== "object" || Array.isArray(environments)) return { format: 1, environments: {} };
  const safe: Record<string, BuildInputRecord> = {};
  for (const [name, entry] of Object.entries(environments)) {
    const record = entry as Partial<BuildInputRecord> | null;
    if (!record || typeof record !== "object" || typeof record.fingerprint !== "string" || !record.signature || typeof record.recordedAt !== "string") continue;
    safe[name] = record as BuildInputRecord;
  }
  return { format: 1, environments: safe };
}

async function writeRecords(root: string, records: BuildInputRecords) {
  const directory = path.dirname(path.join(root, recordFile));
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(root, recordFile);
  const temporary = target + ".writing";
  await fs.writeFile(temporary, JSON.stringify(records, null, 2));
  await fs.rename(temporary, target);
}

/** True when the environment has a build directory with any content (an unrecorded cache may be stale). */
async function cacheExists(root: string, environment: string) {
  const directory = path.join(root, ".pio", "build", environment);
  const stat = await fs.lstat(directory).catch(missing);
  if (!stat) return false;
  if (!stat.isDirectory()) return true;
  return (await fs.readdir(directory)).length > 0;
}

export interface InvalidationPlan { directory: string; targets: string[]; staleDirectory: string }

/**
 * Lists the partition-dependent outputs of one environment. Links are never followed or moved.
 * Anything outside `.pio/build` is refused before the first move.
 */
export async function invalidationPlan(root: string, environment: string): Promise<InvalidationPlan> {
  const buildRoot = path.join(root, ".pio", "build");
  const directory = path.join(buildRoot, environment);
  const stat = await fs.lstat(directory).catch(missing);
  if (!stat) return { directory, targets: [], staleDirectory: staleRoot };
  if (stat.isSymbolicLink()) throw new Error("环境构建目录是符号链接，拒绝移动其中的产物：" + directory);
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(buildRoot), fs.realpath(directory)]);
  const relative = path.relative(realRoot, realDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("环境构建目录超出 .pio/build：" + directory);
  const targets: string[] = [];
  for (const name of partitionArtifacts) {
    const entry = await fs.lstat(path.join(directory, name)).catch(missing);
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
    targets.push(name);
  }
  return { directory, targets, staleDirectory: staleRoot };
}

/** Moves (never deletes) the listed outputs into `.pio/build/.aether-stale/<env>/<timestamp>`. */
export async function invalidateEnvironment(root: string, environment: string): Promise<string[]> {
  const { directory, targets, staleDirectory } = await invalidationPlan(root, environment);
  if (!targets.length) return [];
  const destination = path.join(root, staleDirectory, environment, new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8));
  await fs.mkdir(destination, { recursive: true });
  const moved: string[] = [];
  for (const name of targets) {
    await fs.rename(path.join(directory, name), path.join(destination, name));
    moved.push(".pio/build/" + environment + "/" + name);
  }
  return moved;
}

/**
 * Called before a PlatformIO build or upload starts. When platformio.ini, the active partition
 * table or the selected environment differ from the last recorded build inputs, the environment's
 * partition outputs are moved aside so PlatformIO cannot flash a table generated from older inputs.
 */
export async function prepareBuildCache(root: string, environment: string, config: ProjectConfig): Promise<string> {
  const iniText = await fs.readFile(path.join(root, "platformio.ini"), "utf8");
  const signature = signatureFor(root, environment, iniText, await resolvePartitionInputs(root, config, environment));
  const fingerprint = fingerprintOf(signature);
  const records = await readRecords(root);
  const previous = records.environments[environment];
  let moved: string[] = [];
  let reason: InvalidationResult["reason"];
  if (previous && previous.fingerprint === fingerprint) reason = "unchanged";
  else if (!previous && !(await cacheExists(root, environment))) reason = "no-cache";
  else {
    reason = previous ? "config-changed" : "unknown-cache";
    moved = await invalidateEnvironment(root, environment);
  }
  if (reason !== "unchanged") {
    records.environments[environment] = { fingerprint, signature, recordedAt: new Date().toISOString() };
    await writeRecords(root, records);
  }
  if (!moved.length) return "";
  const cause = reason === "config-changed" ? "platformio.ini 或分区表已变化" : "发现没有配置记录的旧构建缓存";
  return "构建前检查：" + cause + "，已将环境 " + environment + " 的旧产物移出 .pio/build/" + environment +
    "（" + moved.join("、") + "），避免沿用旧分区表。移动后的文件在 " + staleRoot.replace(/\\/g, "/") + "/" + environment + "，未删除。";
}
