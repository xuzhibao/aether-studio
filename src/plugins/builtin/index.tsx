import type { StudioPlugin } from "../api";
import { board, initialComponents, initialWires } from "./hardware";
import { makePart } from "./parts";
import { BoardPart, SensorPart, OledPart, ResistorPart, LedPart, GenericPart, SchematicPart } from "./visuals";
import { lazy, Suspense } from "react";
const LazyEditor = lazy(() => import("../../components/EditorPane").then((m) => ({ default: m.EditorPane })));
function EditorPane({ file }: { file: string }) { return <Suspense fallback={<div className="p-4 text-xs">Loading editor…</div>}><LazyEditor file={file} /></Suspense>; }
import { micropythonPlugin } from "./micropython";
import { demoPlugin } from "./demo";
import { projectFilesPlugin } from "./projectFiles";
import { providerPlugin } from "./provider";
const boardPlugin: StudioPlugin = {
  manifest: { id: "aether.esp32-s3", name: "ESP32-S3 DevKitC-1", type: "board", version: "0.1.0", entry: "builtin/index.tsx#boardPlugin", enabled: true, description: "ESP32-S3 开发板定义、引脚和电路外观。" },
  activate(api) {
    api.register("boards", { id: "esp32-s3", name: board.name, component: "board", description: "双核 LX7 · 8 MB Flash · 2 MB PSRAM" });
    api.register("components", { id: "board", name: board.name, category: "Boards", description: "ESP32-S3", create: () => structuredClone(board), render: BoardPart, schematic: SchematicPart });
  },
};
const componentPlugin: StudioPlugin = {
  manifest: { id: "aether.components", name: "基础元器件库", type: "components", version: "0.1.0", entry: "builtin/index.tsx#componentPlugin", enabled: true, description: "BME280、SSD1306 OLED、LED、电阻、蜂鸣器等九种可编辑元器件。" },
  activate(api) {
    const parts = [
      ["bme280", "BME280", "Sensors", SensorPart], ["oled", "OLED 0.96″", "Displays", OledPart],
      ["led", "LED", "Actuators", LedPart], ["resistor", "Resistor", "Passives", ResistorPart],
      ["buzzer", "Piezo buzzer", "Actuators", GenericPart], ["button", "Push button", "Passives", GenericPart],
      ["dht22", "DHT22", "Sensors", GenericPart], ["soil", "Soil moisture", "Sensors", GenericPart], ["servo", "Micro servo", "Actuators", GenericPart],
    ] as const;
    for (const [id, name, category, render] of parts) api.register("components", { id, name, category, description: makePart(id, 0).name, create: (index) => makePart(id, index), render, schematic: SchematicPart });
  },
};
const editorPlugin: StudioPlugin = {
  manifest: { id: "aether.editor.monaco", name: "Monaco 编辑器", type: "editor", version: "0.1.0", entry: "builtin/index.tsx#editorPlugin", enabled: true, description: "向工作区贡献固件和文本编辑器。" },
  activate(api) { api.register("editors", { id: "monaco", name: "Monaco", render: EditorPane }); },
};
const templatePlugin: StudioPlugin = {
  manifest: { id: "aether.templates", name: "ESP32 示例工程", type: "template", version: "0.1.0", entry: "builtin/index.tsx#templatePlugin", dependencies: ["aether.esp32-s3", "aether.components", "aether.micropython", "aether.editor.monaco"], enabled: true, description: "环境监测示例和空白开发板工程模板。" },
  activate(api) {
    api.register("templates", { id: "Environment monitor", name: "Environment monitor", description: "ESP32-S3 + BME280 + OLED", board: "esp32-s3", create: () => ({ components: structuredClone(initialComponents), wires: structuredClone(initialWires), files: api.capabilities.require("toolchains", "micropython").files(), capabilities: { board: "esp32-s3", toolchain: "micropython", editor: "monaco", simulator: "demo" } }) });
    api.register("templates", { id: "Blank workspace", name: "Blank workspace", description: "仅开发板；自行添加元器件和连线", board: "esp32-s3", create: () => ({ components: [structuredClone(board)], wires: [], files: api.capabilities.require("toolchains", "micropython").files(), capabilities: { board: "esp32-s3", toolchain: "micropython", editor: "monaco", simulator: "demo" } }) });
    api.register("commands", { id: "esp32.example", name: "ESP32-S3: 创建环境监测示例", run: () => api.host.createProject("esp32-s3", "Environment monitor") });
  },
};
export const builtinPlugins = [boardPlugin, componentPlugin, micropythonPlugin, editorPlugin, demoPlugin, providerPlugin, templatePlugin, projectFilesPlugin];
