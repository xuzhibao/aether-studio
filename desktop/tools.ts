import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolSource, ToolStatus } from "../shared/tools";

// Tool identities are declared by plugins; the host only stores and inspects them.
export interface ToolDefinition {
  id: string;
  name: string;
  env: string;
  defaultExecutable: string;
  versionArgs: string[];
  description?: string;
}

interface StoredTools { version: 1; paths: Record<string, string> }

const commandSyntax = /["'`\r\n\0;|<>]|\$\(|&&|\|\|/;
const shellScript = /\.(bat|cmd|ps1)$/i;
const looksLikePath = (value: string) => path.isAbsolute(value) || value.includes("/") || value.includes("\\");

export const validateToolSetting = (value: string) => {
  if (commandSyntax.test(value)) throw new Error("工具设置只接受单个可执行文件路径，不接受命令、参数或 shell 语法");
  if (shellScript.test(value)) throw new Error("工具设置只接受可执行文件，不支持 .bat、.cmd 或 .ps1，因为桌面端不通过 shell 启动工具");
};

const firstLine = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 200) ?? "";

export class ToolService {
  private definitions = new Map<string, ToolDefinition>();
  private paths: Record<string, string> = {};
  private versions = new Map<string, { executable: string; version: string; error: string }>();
  readonly errors: string[] = [];
  constructor(private file: () => string, private changed: (id: string) => void = () => {}) {}

  define(definition: ToolDefinition) { this.definitions.set(definition.id, definition); return definition; }
  require(id: string) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error("未注册的工具：" + id);
    return definition;
  }
  ids() { return [...this.definitions.keys()]; }

  async load() {
    const file = this.file();
    let content: string;
    try { content = await fs.readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.errors.push("读取工具配置失败：" + String(error));
      return;
    }
    try {
      const stored = JSON.parse(content) as StoredTools;
      if (!stored || typeof stored !== "object" || !stored.paths || typeof stored.paths !== "object" || Array.isArray(stored.paths)) throw new Error("配置格式错误");
      for (const [id, value] of Object.entries(stored.paths)) if (typeof value === "string") this.paths[id] = value;
    } catch (error) { this.errors.push("工具配置无法解析，已忽略：" + String(error)); }
  }

  private async persist() {
    const file = this.file();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + ".tmp";
    await fs.writeFile(temporary, JSON.stringify({ version: 1, paths: this.paths } satisfies StoredTools, null, 2));
    await fs.rename(temporary, file);
  }

  configured(id: string) { return this.paths[id]?.trim() ?? ""; }

  // Priority: plugin setting → documented environment variable → PATH lookup of the default name.
  resolve(id: string): { executable: string; source: ToolSource } {
    const definition = this.require(id);
    const configured = this.configured(id);
    if (configured) return { executable: configured, source: "setting" };
    const environment = process.env[definition.env]?.trim();
    if (environment) return { executable: environment, source: "environment" };
    return { executable: definition.defaultExecutable, source: "path" };
  }

  executable(id: string) { return this.resolve(id).executable; }

  async setPath(id: string, value: string) {
    this.require(id);
    if (typeof value !== "string") throw new Error("工具路径必须是文本");
    const trimmed = value.trim();
    if (trimmed) validateToolSetting(trimmed);
    const previous = this.paths[id];
    if (trimmed) this.paths[id] = trimmed; else delete this.paths[id];
    try { await this.persist(); }
    catch (error) {
      if (previous === undefined) delete this.paths[id]; else this.paths[id] = previous;
      throw new Error("保存工具配置失败：" + String(error));
    }
    this.versions.delete(id);
    this.changed(id);
    return this.status(id, false);
  }

  private async findOnPath(command: string) {
    const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
    const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const directory of directories) {
      for (const extension of extensions) {
        const name = command.toLowerCase().endsWith(extension.toLowerCase()) ? command : command + extension;
        const candidate = path.join(directory, name);
        const stat = await fs.stat(candidate).catch(() => null);
        if (stat?.isFile()) return candidate;
      }
    }
    return null;
  }

  private async locate(id: string): Promise<Omit<ToolStatus, "version" | "error" | "checkedAt">> {
    const definition = this.require(id);
    const { executable, source } = this.resolve(id);
    const base = { id, name: definition.name, env: definition.env, description: definition.description ?? "", configured: this.configured(id), executable, source };
    if (shellScript.test(executable)) return { ...base, available: false };
    if (looksLikePath(executable)) {
      const stat = await fs.stat(executable).catch(() => null);
      return { ...base, available: !!stat?.isFile() };
    }
    const found = await this.findOnPath(executable);
    return { ...base, executable: found ?? executable, available: !!found && !shellScript.test(found) };
  }

  private locationError(status: Omit<ToolStatus, "version" | "error" | "checkedAt">) {
    if (status.available) return "";
    if (shellScript.test(status.executable)) return "不支持 .bat、.cmd 或 .ps1；请选择可执行文件（Windows 通常为 .exe）";
    if (looksLikePath(status.executable)) return "找不到可执行文件：" + status.executable;
    return "PATH 中找不到 " + status.executable;
  }

  private async probe(executable: string, args: string[]) {
    if (!args.length) return { version: "", error: "" };
    try {
      const result = await promisify(execFile)(executable, args, { timeout: 8000, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 });
      const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      return { version: firstLine(text), error: "" };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const text = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
      const detail = firstLine(text) || failure.message;
      return { version: firstLine(text), error: `运行 ${path.basename(executable)} ${args.join(" ")} 失败：${detail}` };
    }
  }

  async status(id: string, measure = true): Promise<ToolStatus> {
    const definition = this.require(id);
    const located = await this.locate(id);
    const locationError = this.locationError(located);
    let version = "";
    let error = locationError;
    if (located.available) {
      const cached = this.versions.get(id);
      if (!measure && cached?.executable === located.executable) version = cached.version;
      if (measure) {
        const measured = await this.probe(located.executable, definition.versionArgs);
        this.versions.set(id, { executable: located.executable, version: measured.version, error: measured.error });
        version = measured.version;
        error = measured.error;
      }
    }
    return { ...located, version, error, checkedAt: new Date().toISOString() };
  }

  async list(): Promise<ToolStatus[]> { return Promise.all(this.ids().map((id) => this.status(id, false))); }
}
