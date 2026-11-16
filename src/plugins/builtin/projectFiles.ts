import type { HwComponent, Pin, Wire } from "../../types";
import type { ProjectContext, StudioPlugin } from "../api";
import { isTauri } from "../../lib/desktop";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every((v) => typeof v === "string");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const textFields = (value: Record<string, unknown>, fields: string[]) => fields.every((key) => typeof value[key] === "string");
export const validProjectPath = (path: string) => !!path && !path.includes("\\") && !path.startsWith("/") && !path.includes(":") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

function validPin(value: unknown): value is Pin {
  return record(value) && textFields(value, ["id", "label"]) && !!value.id && (value.note === undefined || typeof value.note === "string") && finite(value.x) && finite(value.y) && ["left", "right", "up", "down"].includes(String(value.dir)) && ["power", "gnd", "i2c", "gpio", "analog", "pwm"].includes(String(value.signal));
}
function validComponent(value: unknown): value is HwComponent {
  return record(value) && textFields(value, ["id", "kind", "name", "reference"]) && !!value.id && !!value.kind && ["x", "y", "w", "h"].every((key) => finite(value[key])) && Number(value.w) > 0 && Number(value.h) > 0 && (value.rotation === undefined || finite(value.rotation)) && strings(value.props) && Array.isArray(value.pins) && value.pins.every(validPin) && new Set(value.pins.map((p) => p.id)).size === value.pins.length;
}
function validWire(value: unknown, components: HwComponent[]): value is Wire {
  if (!record(value) || !textFields(value, ["id", "color"]) || !value.id || (value.lane !== undefined && !finite(value.lane)) || !["power", "gnd", "sda", "scl", "gpio"].includes(String(value.signal))) return false;
  return [value.from, value.to].every((end) => record(end) && textFields(end, ["comp", "pin"]) && components.some((c) => c.id === end.comp && c.pins.some((p) => p.id === end.pin)));
}

export function encodeProject(context: ProjectContext): string {
  const { project, ...workspace } = context;
  return JSON.stringify({ format: "aether-studio", version: 1, project, workspace: { ...workspace, files: { ...workspace.files, "circuit.json": JSON.stringify({ components: workspace.components, wires: workspace.wires }, null, 2) } } }, null, 2);
}
export function decodeProject(content: string): ProjectContext {
  const file = JSON.parse(content);
  if (!record(file) || file.format !== "aether-studio" || file.version !== 1) throw new Error("不支持的 Aether 工程格式或版本");
  const { project, workspace } = file;
  if (!record(project) || !textFields(project, ["id", "name", "description", "board", "template", "accent", "updated"]) || !String(project.name).trim()) throw new Error("工程信息不完整");
  if (!record(workspace) || !Array.isArray(workspace.components) || !workspace.components.every(validComponent) || new Set(workspace.components.map((c) => c.id)).size !== workspace.components.length) throw new Error("工程元器件数据无效");
  if (!Array.isArray(workspace.wires) || !workspace.wires.every((w) => validWire(w, workspace.components as HwComponent[])) || new Set(workspace.wires.map((w) => w.id)).size !== workspace.wires.length) throw new Error("工程连线数据无效或引用了不存在的引脚");
  if (!strings(workspace.files) || !Object.keys(workspace.files).every(validProjectPath)) throw new Error("工程文件名或内容无效");
  if (!record(workspace.capabilities) || !textFields(workspace.capabilities, ["board", "toolchain", "simulator", "editor"])) throw new Error("工程能力绑定无效");
  return { project, components: workspace.components, wires: workspace.wires, files: workspace.files, capabilities: workspace.capabilities } as unknown as ProjectContext;
}

const filters = [{ name: "Aether Studio Project", extensions: ["aether"] }];
async function saveFile(name: string, content: string): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: name, filters });
    if (!path) return null;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, content);
    return path;
  }
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "浏览器下载已开始";
}
async function openFile(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, filters });
    if (!path) return null;
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(path);
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".aether,.json"; input.hidden = true;
    input.oncancel = () => { input.remove(); resolve(null); };
    input.onchange = () => {
      const file = input.files?.[0]; input.remove();
      if (!file) { resolve(null); return; }
      file.text().then(resolve, reject);
    };
    document.body.append(input); input.click();
  });
}
export const projectFilesPlugin: StudioPlugin = {
  manifest: { id: "aether.project-files", name: "工程文件", version: "0.1.0", type: "workspace", entry: "builtin/projectFiles.ts", enabled: true, description: "导入和导出包含电路、代码与能力绑定的 .aether 工程文件；桌面端使用原生文件对话框。" },
  activate(api) {
    api.register("projectFormats", { id: "aether", name: "Aether Studio Project", encode: encodeProject, decode: decodeProject });
    api.register("commands", { id: "project.export", name: "Export project (.aether)", shortcut: "mod+shift+e", run: async () => {
      const context = api.project.get();
      const name = context.project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") + ".aether";
      const result = await saveFile(name, encodeProject(context));
      if (result) api.host.notify("工程已导出", result);
    } });
    api.register("commands", { id: "project.import", name: "Open project (.aether)", shortcut: "mod+shift+o", run: async () => {
      const content = await openFile();
      if (content === null) return;
      const project = decodeProject(content);
      api.host.importProject(project);
      api.host.notify("工程已导入", project.project.name + " · 已作为新的本地工程打开");
    } });
    api.register("menus", { id: "project.open.menu", name: "Open project (.aether)", command: "project.import", location: "project" });
    api.register("menus", { id: "project.export.menu", name: "Export project (.aether)", command: "project.export", location: "project" });
    api.register("menus", { id: "project.export.share", name: "Export project bundle", command: "project.export", location: "share" });
  },
};
