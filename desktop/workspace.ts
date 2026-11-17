import { promises as fs } from "node:fs";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "chokidar";
import { decodeProject, encodeProject, validProjectPath } from "../shared/projectFormat";
import type { ProjectContext } from "../src/plugins/api";
import type { DiskWorkspace } from "../shared/desktop";
const ignored = new Set([".git", ".pio", ".aether", "node_modules", "dist", "build", "target", "release", "desktop-dist", ".cache"]);
const manifestName = "aether.project.json";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const diskName = (file: string) => file === "circuit.json" ? "hardware/circuit.json" : file;

export class WorkspaceService {
  root: string | null = null;
  private baseline = new Map<string, string>();
  private watcher?: FSWatcher;
  private writing = false;
  constructor(private changed: (root: string) => void = () => {}) {}
  async close() { const old = this.watcher; this.watcher = undefined; this.root = null; this.baseline.clear(); await old?.close(); }
  private requireRoot() { if (!this.root) throw new Error("请先打开工程目录"); return this.root; }
  private async target(name: string) {
    if (!validProjectPath(name)) throw new Error("工程相对路径无效：" + name);
    const root = this.requireRoot();
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error("不通过工程链接写入文件：" + name);
    }
    return current;
  }
  private async read(root: string): Promise<DiskWorkspace> {
    const files: Record<string, string> = {};
    const walk = async (directory: string, prefix = "") => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (ignored.has(item.name) || item.name.endsWith(".aether-saving") || item.isSymbolicLink()) continue;
        const relative = prefix + item.name;
        if (item.isDirectory()) { await walk(path.join(directory, item.name), relative + "/"); continue; }
        if (!item.isFile() || relative === manifestName || relative === "hardware/circuit.json") continue;
        const stat = await fs.stat(path.join(directory, item.name));
        if (stat.size > 1024 * 1024) continue;
        const buffer = await fs.readFile(path.join(directory, item.name));
        if (!buffer.includes(0) && isUtf8(buffer)) files[relative] = buffer.toString("utf8");
      }
    };
    await walk(root);
    const optional = async (name: string) => fs.readFile(path.join(root, name), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    for (const name of [manifestName, "hardware", "hardware/circuit.json"]) {
      const stat = await fs.lstat(path.join(root, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
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
    return { root, context };
  }
  async open(directory: string): Promise<DiskWorkspace> {
    const root = await fs.realpath(directory);
    const result = await this.read(root); // Do not discard the old session if parsing fails.
    await this.close();
    this.root = root;
    await this.captureBaseline(result.context);
    this.watcher = watch(root, { ignoreInitial: true, ignored: (entry) => path.relative(root, entry).split(path.sep).some((part) => ignored.has(part)), awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
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
      const text = await fs.readFile(path.join(this.requireRoot(), name), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (text !== null) this.baseline.set(name, digest(text));
    }
  }
  async reload() { return this.open(this.requireRoot()); }
  async fingerprint(exclude: string[] = []) { const context = (await this.read(this.requireRoot())).context; for (const file of exclude) delete context.files[file]; return digest(encodeProject(context)); }
  async save(context: ProjectContext) {
    const validated = decodeProject(encodeProject(context));
    const root = this.requireRoot();
    if (Object.keys(validated.files).some((file) => file === manifestName || file === "hardware/circuit.json")) throw new Error("工程元数据与电路文件由宿主管理");
    const outputs = new Map(Object.entries(validated.files).map(([name, text]) => [diskName(name), text]));
    outputs.set("hardware/circuit.json", JSON.stringify({ components: validated.components, wires: validated.wires }, null, 2));
    outputs.set(manifestName, JSON.stringify({ format: "aether-directory", version: 1, project: validated.project, capabilities: validated.capabilities }, null, 2));
    // Validate every target before writing anything, including newly created files.
    for (const name of outputs.keys()) {
      if (name.split("/").some((part) => ignored.has(part))) throw new Error("不能写入工具缓存目录：" + name);
      const target = await this.target(name);
      const current = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if ((current === null ? undefined : digest(current)) !== this.baseline.get(name)) throw new Error("文件已被外部修改：" + name + "。请重新读取目录或另存工程。");
    }
    this.writing = true;
    try {
      for (const [name, text] of outputs) {
        const target = await this.target(name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = target + ".aether-saving";
        if (await fs.lstat(temporary).catch(() => null)) throw new Error("临时保存文件已存在：" + temporary);
        await fs.writeFile(temporary, text, { flag: "wx" });
        await fs.rename(temporary, target);
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
