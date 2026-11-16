import type { ComponentType } from "react";
import type { HwComponent, ProjectMeta, Wire } from "../types";

export interface ProjectWorkspace {
  components: HwComponent[];
  wires: Wire[];
  files: Record<string, string>;
  capabilities: { board: string; toolchain: string; simulator: string; editor: string };
}
export interface ProjectContext extends ProjectWorkspace { project: ProjectMeta }
export type PluginType = "board" | "components" | "toolchain" | "simulator" | "ai-provider" | "editor" | "template" | "workspace" | "agent" | "tool" | "transport" | "deployment";
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: PluginType;
  entry: string;
  description: string;
  dependencies?: string[];
  enabled: boolean;
  settingsHelp?: string;
  settings?: { key: string; label: string; type: "text" | "url" | "password"; placeholder?: string; persist?: boolean }[];
}
export interface PartViewProps {
  comp: HwComponent;
  onPinClick?: (pin: string) => void;
  selectedPin?: string | null;
  running: boolean;
  connected: Record<string, string>;
  readings: { temperature: number; humidity: number; pressure: number };
  on: boolean;
}
export interface PartDefinition {
  id: string;
  name: string;
  category: string;
  description: string;
  create: (index: number) => HwComponent;
  render: ComponentType<PartViewProps>;
  schematic: ComponentType<{ comp: HwComponent }>;
}
export interface SimulationFrame {
  readings: PartViewProps["readings"];
  lines: string[];
}
export interface AIMessage { role: "system" | "user" | "assistant"; content: string }
export interface CapabilityMap {
  boards: { id: string; name: string; component: string; description: string };
  components: PartDefinition;
  editors: { id: string; name: string; render: ComponentType<{ file: string }> };
  toolchains: { id: string; name: string; files: () => Record<string, string>; check: (project: ProjectContext) => string[] };
  simulators: { id: string; name: string; start: (project: ProjectContext) => string[]; tick: (project: ProjectContext, elapsed: number) => SimulationFrame };
  agents: { id: string; name: string; run: (project: ProjectContext, messages: AIMessage[], signal?: AbortSignal) => Promise<string> };
  providers: { id: string; name: string; complete: (messages: AIMessage[], signal?: AbortSignal) => Promise<string> };
  templates: { id: string; name: string; description: string; board: string; create: () => ProjectWorkspace };
  commands: { id: string; name: string; run: () => void | Promise<void> };
  overlays: { id: string; render: ComponentType<{ readings: PartViewProps["readings"]; running: boolean }> };
  panels: { id: string; name: string; render: ComponentType };
  menus: { id: string; name: string; command: string };
}
export interface PluginHost {
  getProject: () => ProjectContext;
  log: (text: string) => void;
  runSimulation: () => void;
  createProject: (board: string, template: string) => void;
}
export interface PluginAPI {
  readonly manifest: PluginManifest;
  readonly project: { get: () => ProjectContext };
  capabilities: { require: <K extends keyof CapabilityMap>(kind: K, id: string) => CapabilityMap[K] };
  register: <K extends keyof CapabilityMap>(kind: K, value: CapabilityMap[K]) => void;
  events: { emit: (event: string, data?: unknown) => void; on: (event: string, listener: (data: unknown) => void) => () => void };
  settings: { get: (key: string) => string; set: (key: string, value: string, persist?: boolean) => void };
  host: PluginHost;
}
export interface StudioPlugin {
  manifest: PluginManifest;
  activate: (api: PluginAPI) => void;
  deactivate?: () => void;
}
export interface PluginInfo { manifest: PluginManifest; enabled: boolean; capabilities: string[] }
