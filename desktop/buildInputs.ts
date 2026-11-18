import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** The shape PlatformIO Core prints for `project config --json-output`. */
export type ProjectConfig = [string, [string, unknown][]][];

/**
 * Partition tables that ship with the ESP32 platform/framework and win over a project file of the
 * same name (verified with PlatformIO Core 6.1.19 + espressif32 6.12.0). Their content belongs to
 * the installed platform, so the pinned `platform = ...` value in platformio.ini identifies them.
 */
const builtInPartitions = new Set([
  "app3m_fat9m_16mb.csv", "app3m_fat9m_fact512k_16mb.csv", "app3m_spiffs9m_fact512k_16mb.csv",
  "bare_minimum_2mb.csv", "default", "default.csv", "default_16mb.csv", "default_8mb.csv",
  "default_ffat.csv", "default_ffat_8mb.csv", "ffat.csv", "huge_app.csv", "large_fat_32mb.csv",
  "large_ffat_8mb.csv", "large_littlefs_32mb.csv", "large_spiffs_16mb.csv", "large_spiffs_8mb.csv",
  "max_app_8mb.csv", "min_spiffs.csv", "minimal.csv", "no_ota.csv", "noota_3g.csv", "noota_3gffat.csv",
  "noota_ffat.csv", "rainmaker.csv",
]);

export interface PartitionInput {
  /** Where the value came from: the resolved env section of `pio project config`. */
  source: string;
  /** Project-relative path in POSIX form; null for a platform-provided table. */
  path: string | null;
  /** Platform table name as written in platformio.ini. */
  name?: string;
  sha256: string | null;
  kind: "file" | "builtin";
}

export interface BuildInputSignature {
  format: 1;
  root: string;
  environment: string;
  /** Effective build directory, project-relative in POSIX form (honors build_dir/workspace_dir). */
  buildDir: string;
  iniSha256: string;
  /** Hash of the merged `pio project config` output; also covers `extra_configs` files. */
  configSha256: string;
  partitions: PartitionInput[];
}

export interface BuildInputRecord {
  fingerprint: string;
  signature: BuildInputSignature;
  recordedAt: string;
}

interface BuildInputRecords { format: 1; environments: Record<string, BuildInputRecord> }

export interface InvalidationPlan { directory: string; targets: string[] }

const recordFile = path.join(".aether", "build-config.json");
// Only outputs whose content depends on the partition layout are moved. The ELF and map stay in
// place: removing firmware.bin already forces a relink, and keeping them avoids large copies.
const partitionArtifacts = ["partitions.bin", "partitions.csv", "bootloader.bin", "firmware.bin"];

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const absent = (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error);

export function assertEnvironmentName(environment: string) {
  if (!environment || environment === "." || environment === ".." || /[\\/]/.test(environment) || environment.includes(":")) throw new Error("无效的构建环境名：" + environment);
}

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

const expandProjectDir = (root: string, value: string) => value.replace(/\$\{PROJECT_DIR\}/gi, () => root).replace(/^"|"$/g, "").trim();

/** Refuses a path when any component below the project root is a link. */
async function assertNoLinks(root: string, parts: string[], label: string) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(absent);
    if (stat?.isSymbolicLink()) throw new Error(label + "是符号链接，拒绝操作：" + current);
  }
}

async function assertPlainFile(root: string, relative: string) {
  await assertNoLinks(root, relative.split("/"), "分区表路径");
  const stat = await fs.lstat(path.join(root, relative));
  if (!stat.isFile()) throw new Error("分区表不是普通文件：" + relative);
}

/** PlatformIO resolves relative paths against the project directory. */
function projectRelative(root: string, value: string) {
  const expanded = expandProjectDir(root, value);
  if (!expanded) throw new Error("board_build.partitions 为空");
  if (/\$\{[^}]+\}/.test(expanded)) throw new Error("无法解析分区表路径中的插值：" + value + "。请在 platformio.ini 中使用字面路径。");
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(root, expanded);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { relative: null, literal: expanded };
  return { relative: relative.split(path.sep).join("/"), literal: expanded };
}

/**
 * The build directory PlatformIO actually uses for this project. `pio project config` expands
 * `build_dir`/`workspace_dir` to absolute paths; PLATFORMIO_BUILD_DIR / PLATFORMIO_WORKSPACE_DIR
 * are applied at build time and are honored here as well. A directory outside the project is
 * refused instead of being silently ignored.
 */
export async function resolveBuildDirectory(root: string, config: ProjectConfig): Promise<string> {
  const options = sectionMap(config).get("platformio") ?? {};
  const environmentBuild = process.env.PLATFORMIO_BUILD_DIR?.trim();
  const environmentWorkspace = process.env.PLATFORMIO_WORKSPACE_DIR?.trim();
  const build = environmentBuild || (typeof options.build_dir === "string" ? options.build_dir : "");
  const workspace = environmentWorkspace || (typeof options.workspace_dir === "string" ? options.workspace_dir : "");
  const absolute = build
    ? path.resolve(root, expandProjectDir(root, build))
    : workspace ? path.join(path.resolve(root, expandProjectDir(root, workspace)), "build") : path.join(root, ".pio", "build");
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PlatformIO 构建目录在工程目录之外，无法安全地失效旧分区产物：" + absolute + "。请把 build_dir/workspace_dir 保持在工程内，或手动清理该环境。");
  }
  const normalized = relative.split(path.sep).join("/");
  await assertNoLinks(root, normalized.split("/"), "PlatformIO 构建目录");
  return normalized;
}

/**
 * The partition table PlatformIO actually uses for one environment. `pio project config` already
 * expands `[env]` defaults and `extends` chains (including `[common]`) into `env:<name>`, so that
 * section is authoritative. Built-in table names win over a project file with the same name;
 * other existing project files are used and hashed by content.
 */
export async function resolvePartitionInputs(root: string, config: ProjectConfig, environment: string): Promise<PartitionInput[]> {
  assertEnvironmentName(environment);
  const options = sectionMap(config).get("env:" + environment);
  if (!options) throw new Error("platformio.ini 中没有环境：" + environment);
  const value = options["board_build.partitions"];
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error("board_build.partitions 必须是字符串：" + JSON.stringify(value));
  const source = "env:" + environment;
  const { relative, literal } = projectRelative(root, value);
  if (relative === null) throw new Error("分区表必须位于工程目录内：" + literal);
  const bare = !literal.includes("/") && !literal.includes("\\");
  if (bare && builtInPartitions.has(literal.toLowerCase())) return [{ source, kind: "builtin", path: null, name: literal, sha256: null }];
  const stat = await fs.lstat(path.join(root, relative)).catch(absent);
  if (stat) {
    await assertPlainFile(root, relative);
    return [{ source, kind: "file", path: relative, sha256: sha256(await fs.readFile(path.join(root, relative))) }];
  }
  // Not a project file. PlatformIO will look it up among the installed platform tables and fail
  // before flashing if the name is unknown; the name alone is part of the signature.
  if (!bare) throw new Error("找不到 platformio.ini 指定的分区表：" + relative);
  return [{ source, kind: "builtin", path: null, name: literal, sha256: null }];
}

export function signatureFor(root: string, environment: string, iniText: string, config: ProjectConfig, buildDir: string, partitions: PartitionInput[]): BuildInputSignature {
  return { format: 1, root, environment, buildDir, iniSha256: sha256(iniText), configSha256: sha256(JSON.stringify(config)), partitions };
}

/** Stable fingerprint: fields are created in a fixed order, so the JSON text is deterministic. */
export const fingerprintOf = (signature: BuildInputSignature) => sha256(JSON.stringify(signature));

async function readRecords(root: string): Promise<BuildInputRecords> {
  await assertNoLinks(root, [".aether"], "构建配置记录目录");
  const target = path.join(root, recordFile);
  const stat = await fs.lstat(target).catch(absent);
  // A linked record is not trusted; the next build re-checks the cache instead.
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return { format: 1, environments: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(target, "utf8")); }
  catch { return { format: 1, environments: {} }; }
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
  await assertNoLinks(root, [".aether"], "构建配置记录目录");
  const directory = path.join(root, ".aether");
  const directoryStat = await fs.lstat(directory).catch(absent);
  if (directoryStat && !directoryStat.isDirectory()) throw new Error(".aether 不是目录，拒绝写入构建配置记录：" + directory);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(root, recordFile);
  await assertNoLinks(root, [".aether", path.join(".aether", "build-config.json")], "构建配置记录");
  const temporary = target + ".writing";
  const existing = await fs.lstat(temporary).catch(absent);
  // A leftover temp from a previous interrupted write is our own file and can be replaced; links
  // and directories are never written through.
  if (existing?.isSymbolicLink()) throw new Error("临时构建配置记录是符号链接，拒绝写入：" + temporary);
  if (existing && !existing.isFile()) throw new Error("临时构建配置记录不是普通文件，拒绝写入：" + temporary);
  await fs.writeFile(temporary, JSON.stringify(records, null, 2), existing ? undefined : { flag: "wx" });
  await fs.rename(temporary, target);
}

/** True when the environment has a build directory with any content (an unrecorded cache may be stale). */
async function cacheExists(root: string, buildDir: string, environment: string) {
  const directory = path.join(root, buildDir, environment);
  const stat = await fs.lstat(directory).catch(absent);
  if (!stat) return false;
  if (!stat.isDirectory()) return true;
  return (await fs.readdir(directory)).length > 0;
}

/**
 * Lists the partition-dependent outputs of one environment. The build directory and the environment
 * directory inside it must be plain directories; links are refused rather than followed.
 */
export async function invalidationPlan(root: string, buildDir: string, environment: string): Promise<InvalidationPlan> {
  assertEnvironmentName(environment);
  await assertNoLinks(root, buildDir.split("/"), "PlatformIO 构建目录");
  const directory = path.join(root, buildDir, environment);
  await assertNoLinks(root, [...buildDir.split("/"), environment], "环境构建目录");
  const stat = await fs.lstat(directory).catch(absent);
  if (!stat) return { directory, targets: [] };
  if (!stat.isDirectory()) return { directory, targets: [] };
  const targets: string[] = [];
  for (const name of partitionArtifacts) {
    const entry = await fs.lstat(path.join(directory, name)).catch(absent);
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
    targets.push(name);
  }
  return { directory, targets };
}

/**
 * Moves (never deletes) the listed outputs into `<build dir>/.aether-stale/<environment>/`. Replacing
 * a previous copy of the same generated file keeps one recent quarantine instead of accumulating
 * files on every table change.
 */
export async function invalidateEnvironment(root: string, buildDir: string, environment: string): Promise<string[]> {
  const { directory, targets } = await invalidationPlan(root, buildDir, environment);
  if (!targets.length) return [];
  const stale = path.join(root, buildDir, ".aether-stale");
  const destination = path.join(stale, environment);
  await assertNoLinks(root, [...buildDir.split("/"), ".aether-stale"], "旧构建产物目录");
  const destinationStat = await fs.lstat(destination).catch(absent);
  if (destinationStat?.isSymbolicLink()) throw new Error("旧构建产物目录是符号链接，拒绝写入：" + destination);
  await fs.mkdir(destination, { recursive: true });
  const moved: string[] = [];
  for (const name of targets) {
    await fs.rename(path.join(directory, name), path.join(destination, name));
    moved.push(buildDir + "/" + environment + "/" + name);
  }
  return moved;
}

/**
 * Called before a PlatformIO build or upload starts. When platformio.ini, another config file
 * (`extra_configs`), the active partition table, the build directory or the selected environment
 * differ from the last recorded build inputs, the environment's partition outputs are moved aside
 * so PlatformIO cannot flash a table generated from older inputs.
 */
export async function prepareBuildCache(root: string, environment: string, config: ProjectConfig): Promise<string> {
  const iniText = await fs.readFile(path.join(root, "platformio.ini"), "utf8");
  const buildDir = await resolveBuildDirectory(root, config);
  const signature = signatureFor(root, environment, iniText, config, buildDir, await resolvePartitionInputs(root, config, environment));
  const fingerprint = fingerprintOf(signature);
  const records = await readRecords(root);
  const previous = records.environments[environment];
  let moved: string[] = [];
  let reason: "unchanged" | "no-cache" | "config-changed" | "unknown-cache";
  if (previous && previous.fingerprint === fingerprint) reason = "unchanged";
  else if (!previous && !(await cacheExists(root, buildDir, environment))) reason = "no-cache";
  else {
    reason = previous ? "config-changed" : "unknown-cache";
    moved = await invalidateEnvironment(root, buildDir, environment);
  }
  if (reason !== "unchanged") {
    records.environments[environment] = { fingerprint, signature, recordedAt: new Date().toISOString() };
    await writeRecords(root, records);
  }
  if (!moved.length) return "";
  const cause = reason === "config-changed" ? "platformio.ini/其他配置文件或分区表已变化" : "发现没有配置记录的旧构建缓存";
  return "构建前检查：" + cause + "，已将环境 " + environment + " 的旧产物移出 " + buildDir + "/" + environment +
    "（" + moved.join("、") + "），避免沿用旧分区表。移动后的文件在 " + buildDir + "/.aether-stale/" + environment + "（同名只保留最近一份），未删除其他文件。";
}
