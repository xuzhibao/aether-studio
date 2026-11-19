import { promises as fs } from "node:fs";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "chokidar";
import { decodeProject, encodeProject, validProjectPath } from "../shared/projectFormat";
import type { ProjectContext } from "../src/plugins/api";
import type { DiskListing, DiskWorkspace } from "../shared/desktop";
const ignored = new Set([".git", ".pio", ".aether", "node_modules", "dist", "build", "target", "release", "desktop-dist", ".cache"]);
const manifestName = "aether.project.json";
// Paths owned by the host: metadata, the virtual circuit view and its physical location.
const reserved = new Set([manifestName, "circuit.json", "hardware", "hardware/circuit.json"]);
// Case-insensitive filesystems alias names differing only by case (Windows and default macOS).
// On case-sensitive filesystems these are distinct entries, so folding is limited to those platforms.
const foldCase = process.platform === "win32" || process.platform === "darwin";
const fold = (value: string) => foldCase ? value.toLowerCase() : value;
const ignoredNames = new Set([...ignored].map(fold));
const reservedNames = new Set([...reserved].map(fold));
// PlatformIO ESP-IDF writes sdkconfig.<env> and sdkconfig.old into the project root during a build.
// They are generated artifacts, not inputs; user-provided sdkconfig.defaults* stay tracked.
const generatedSdkconfig = /^sdkconfig\.(?!defaults(?:\.|$)).+$/i;
const isIgnoredPart = (part: string) => ignoredNames.has(fold(part)) || generatedSdkconfig.test(part);
const isReservedPath = (name: string) => {
  const parts = name.split("/");
  for (let index = 1; index <= parts.length; index++) if (reservedNames.has(fold(parts.slice(0, index).join("/")))) return true;
  return false;
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const diskName = (file: string) => file === "circuit.json" ? "hardware/circuit.json" : file;
const absent = (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; };

export class WorkspaceService {
  root: string | null = null;
  private baseline = new Map<string, string>();
  private watcher?: FSWatcher;
  private writing = false;
  constructor(
    private changed: (root: string) => void = () => {},
    private trashItem: (target: string) => Promise<void> = async () => { throw new Error("此环境没有可用的系统回收站；不会执行永久删除。"); },
  ) {}
  async close() { const old = this.watcher; this.watcher = undefined; this.root = null; this.baseline.clear(); await old?.close(); }
  private requireRoot() { if (!this.root) throw new Error("请先打开工程目录"); return this.root; }
  private async target(name: string) {
    if (!validProjectPath(name)) throw new Error("工程相对路径无效：" + name);
    const root = this.requireRoot();
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(absent);
      if (stat?.isSymbolicLink()) throw new Error("不通过工程链接操作文件：" + name);
    }
    if (!current.startsWith(root + path.sep)) throw new Error("路径超出工程目录：" + name);
    return current;
  }
  private checkName(name: string) {
    if (!validProjectPath(name)) throw new Error("工程相对路径无效：" + name);
    if (name.split("/").some(isIgnoredPart)) throw new Error("不能操作工具缓存目录：" + name);
    if (isReservedPath(name)) throw new Error("此路径由宿主管理，不能创建、重命名、写入或删除：" + name);
  }
  private async scan(root: string): Promise<DiskListing> {
    const files: Record<string, string> = {};
    const directories: string[] = [];
    const walk = async (directory: string, prefix = "") => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (isIgnoredPart(item.name) || item.name.endsWith(".aether-saving") || item.isSymbolicLink()) continue;
        const relative = prefix + item.name;
        if (item.isDirectory()) {
          // hardware/ holds the host-owned circuit file; browsing it is handled through the virtual circuit.json.
          if (!prefix && fold(item.name) === fold("hardware")) continue;
          directories.push(relative);
          await walk(path.join(directory, item.name), relative + "/");
          continue;
        }
        if (!item.isFile() || relative === manifestName || relative === "hardware/circuit.json") continue;
        const stat = await fs.stat(path.join(directory, item.name));
        if (stat.size > 1024 * 1024) continue;
        const buffer = await fs.readFile(path.join(directory, item.name));
        if (!buffer.includes(0) && isUtf8(buffer)) files[relative] = buffer.toString("utf8");
      }
    };
    await walk(root);
    directories.sort();
    return { files, directories };
  }
  private async read(root: string): Promise<DiskWorkspace> {
    const { files, directories } = await this.scan(root);
    const optional = async (name: string) => fs.readFile(path.join(root, name), "utf8").catch(absent);
    for (const name of [manifestName, "hardware", "hardware/circuit.json"]) {
      const stat = await fs.lstat(path.join(root, name)).catch(absent);
      if (stat?.isSymbolicLink()) throw new Error("不通过链接读取工程元数据：" + name);
    }
    if (Object.hasOwn(files, "circuit.json")) throw new Error("根目录 circuit.json 与电路视图保留名称冲突，请先重命名此文件");
    const metadata = await optional(manifestName);
    const circuit = await optional("hardware/circuit.json");
    const meta = metadata ? JSON.parse(metadata) : {
      format: "aether-directory", version: 1,
      project: { id: digest(root).slice(0, 16), name: path.basename(root), description: "本地文件工程", board: "", template: "", accent: "#007AFF", updated: "Local" },
      capabilities: { board: "", toolchain: files["platformio.ini"] !== undefined ? "platformio" : "micropython", simulator: "", editor: "monaco" },
    };
    if (meta.format !== "aether-directory" || meta.version !== 1) throw new Error("不支持的工程目录格式");
    const graph = circuit ? JSON.parse(circuit) : { components: [], wires: [] };
    const context = decodeProject(JSON.stringify({ format: "aether-studio", version: 1, project: meta.project, workspace: { ...graph, files, capabilities: meta.capabilities } }));
    context.files["circuit.json"] = JSON.stringify(graph, null, 2);
    return { root, context, directories };
  }
  async open(directory: string): Promise<DiskWorkspace> {
    const root = await fs.realpath(directory);
    const result = await this.read(root); // Do not discard the old session if parsing fails.
    await this.close();
    this.root = root;
    await this.captureBaseline(result.context);
    this.watcher = watch(root, { ignoreInitial: true, ignored: (entry) => path.relative(root, entry).split(path.sep).some(isIgnoredPart), awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    this.watcher.on("all", async (event, file) => {
      if (this.writing || this.root !== root || !["add", "change", "unlink"].includes(event) || file.endsWith(".aether-saving")) return;
      const relative = path.relative(root, file).split(path.sep).join("/");
      const content = await fs.readFile(file, "utf8").catch(() => null);
      if ((content === null ? undefined : digest(content)) !== this.baseline.get(relative)) this.changed(root);
    });
    this.watcher.on("error", () => this.changed(root));
    return result;
  }
  private async captureBaseline(context: ProjectContext) {
    this.baseline.clear();
    for (const name of [...Object.keys(context.files).map(diskName), manifestName]) {
      const text = await fs.readFile(path.join(this.requireRoot(), name), "utf8").catch(absent);
      if (text !== null) this.baseline.set(name, digest(text));
    }
  }
  private rekeyBaseline(from: string, to: string) {
    const next = new Map<string, string>();
    for (const [name, hash] of this.baseline) {
      if (name === from) next.set(to, hash);
      else if (name.startsWith(from + "/")) next.set(to + name.slice(from.length), hash);
      else next.set(name, hash);
    }
    this.baseline.clear(); for (const [name, hash] of next) this.baseline.set(name, hash);
  }
  private dropBaseline(name: string) {
    for (const key of [...this.baseline.keys()]) if (key === name || key.startsWith(name + "/")) this.baseline.delete(key);
  }
  private async writeAtomic(target: string, text: string) {
    const temporary = target + ".aether-saving";
    if (await fs.lstat(temporary).catch(() => null)) throw new Error("临时保存文件已存在：" + temporary);
    await fs.writeFile(temporary, text, { flag: "wx" });
    // Windows briefly returns EPERM/EBUSY when a virus scanner or another handle holds the destination open.
    // Retrying keeps the write atomic instead of failing the whole project save on a transient lock.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, target); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }
  async listing(): Promise<DiskListing> { return this.scan(this.requireRoot()); }
  async createFile(name: string) {
    this.checkName(name);
    const target = await this.target(name);
    if (await fs.lstat(target).catch(absent)) throw new Error("同名文件或目录已存在：" + name);
    await fs.mkdir(path.dirname(target), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST" || error.code === "ENOTDIR") throw new Error("上级路径不是目录：" + name);
      throw error;
    });
    if (await fs.lstat(target).catch(absent)) throw new Error("同名文件或目录已存在：" + name);
    await fs.writeFile(target, "", { flag: "wx" });
    this.baseline.set(name, digest(""));
  }
  async createDirectory(name: string) {
    this.checkName(name);
    const target = await this.target(name);
    if (await fs.lstat(target).catch(absent)) throw new Error("同名文件或目录已存在：" + name);
    await fs.mkdir(target, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST" || error.code === "ENOTDIR") throw new Error("上级路径不是目录：" + name);
      throw error;
    });
  }
  async rename(from: string, to: string) {
    this.checkName(from); this.checkName(to);
    if (from === to) throw new Error("新路径与原路径相同");
    const source = await this.target(from);
    const sourceStat = await fs.lstat(source).catch(absent);
    if (!sourceStat) throw new Error("要重命名的文件或目录不存在：" + from);
    if (sourceStat.isSymbolicLink()) throw new Error("不操作工程内的符号链接：" + from);
    const target = await this.target(to);
    const existing = await fs.lstat(target).catch(absent);
    if (existing) {
      // Replacing is only safe when source and target are the same actual file (a real case-only rename).
      const [sourceReal, targetReal] = await Promise.all([fs.realpath(source), fs.realpath(target)]);
      if (sourceReal !== targetReal) throw new Error("同名文件或目录已存在：" + to);
    }
    await fs.rename(source, target);
    this.rekeyBaseline(from, to);
  }
  async trash(name: string) {
    this.checkName(name);
    const target = await this.target(name);
    const stat = await fs.lstat(target).catch(absent);
    if (!stat) throw new Error("要移入回收站的路径不存在：" + name);
    if (stat.isSymbolicLink()) throw new Error("不操作工程内的符号链接：" + name);
    this.writing = true;
    try { await this.trashItem(target); } finally { this.writing = false; }
    this.dropBaseline(name);
  }
  /**
   * Marks the current disk content as the accepted baseline after a per-file review. When the caller
   * saw a specific content (the listing it reviewed), a later write must not be silently accepted.
   */
  async accept(name: string, expected?: string | null) {
    this.checkName(name);
    const target = await this.target(name);
    const current = await fs.readFile(target, "utf8").catch(absent);
    if (expected !== undefined && current !== expected) throw new Error("文件内容在检查后已再次改变：" + name + "。请重新检查磁盘变更。");
    if (current === null) this.baseline.delete(name);
    else this.baseline.set(name, digest(current));
  }
  async write(name: string, text: string, expected: string | null) {
    this.checkName(name);
    const target = await this.target(name);
    const current = await fs.readFile(target, "utf8").catch(absent);
    if (current !== expected) throw new Error("文件内容在预览后已再次改变：" + name + "。请重新检查磁盘变更。");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.writeAtomic(target, text);
    this.baseline.set(name, digest(text));
  }
  async reload() { return this.open(this.requireRoot()); }
  async fingerprint(exclude: string[] = []) { const context = (await this.read(this.requireRoot())).context; for (const file of exclude) delete context.files[file]; return digest(encodeProject(context)); }
  async save(context: ProjectContext) {
    const validated = decodeProject(encodeProject(context));
    const root = this.requireRoot();
    if (Object.keys(validated.files).some((file) => file === manifestName || file === "hardware/circuit.json")) throw new Error("工程元数据与电路文件由宿主管理");
    // Reject aliases of protected paths before writing anything (case-insensitive filesystems).
    for (const file of Object.keys(validated.files)) {
      const stored = diskName(file);
      if (stored !== "hardware/circuit.json") this.checkName(stored);
    }
    const outputs = new Map(Object.entries(validated.files).map(([name, text]) => [diskName(name), text]));
    outputs.set("hardware/circuit.json", JSON.stringify({ components: validated.components, wires: validated.wires }, null, 2));
    outputs.set(manifestName, JSON.stringify({ format: "aether-directory", version: 1, project: validated.project, capabilities: validated.capabilities }, null, 2));
    // Validate every target before writing anything, including newly created files.
    for (const name of outputs.keys()) {
      if (name.split("/").some(isIgnoredPart)) throw new Error("不能写入工具缓存目录：" + name);
      const target = await this.target(name);
      const current = await fs.readFile(target, "utf8").catch(absent);
      if ((current === null ? undefined : digest(current)) !== this.baseline.get(name)) throw new Error("文件已被外部修改：" + name + "。请按文件处理磁盘变更，或另存工程。");
    }
    this.writing = true;
    try {
      for (const [name, text] of outputs) {
        const target = await this.target(name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await this.writeAtomic(target, text);
        this.baseline.set(name, digest(text));
      }
    } finally { this.writing = false; }
    return root;
  }
  async saveAs(directory: string, context: ProjectContext) {
    if ((await fs.readdir(directory)).length) throw new Error("请选择空目录，已有文件不会被覆盖");
    const previous = this.root;
    await this.close(); this.root = await fs.realpath(directory);
    try { await this.save(context); return await this.open(directory); }
    catch (error) { if (previous) await this.open(previous); else await this.close(); throw error; }
  }
}
