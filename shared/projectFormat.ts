import type { HwComponent, Pin, Wire } from "../src/types";
import type { ProjectContext } from "../src/plugins/api";

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

