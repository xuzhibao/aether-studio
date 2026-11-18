import type { ComponentType } from "react";
import type { HwComponent, ProjectMeta, Wire, EditProposal, ToolRun } from "../types";
import type { EspInspectResult, EspPreflightAllow, EspPreflightResult } from "../../shared/esp";

export interface ProjectWorkspace {
  components: HwComponent[];
  wires: Wire[];
  files: Record<string, string>;
  capabilities: { board: string; toolchain: string; simulator: string; editor: string };
}
export interface ProjectContext extends ProjectWorkspace { project: ProjectMeta }
export type PluginType = "board" | "components" | "toolchain" | "simulator" | "ai-provider" | "editor" | "template" | "workspace" | "agent" | "tool" | "transport" | "deployment" | "language" | "terminal" | "device";
export interface PluginSettingField {
  key: string;
  label: string;
  type: "text" | "url" | "password" | "tool-path";
  placeholder?: string;
  persist?: boolean;
  /** Desktop tool identity owned by the plugin; the host provides storage and status probing. */
  tool?: string;
  help?: string;
}
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
  settings?: PluginSettingField[];
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
export interface AIToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface AIMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: AIToolCall[]; tool_call_id?: string }
export interface AgentResult { text: string; proposals?: EditProposal[]; toolRuns?: ToolRun[] }
export interface TransportPort { path: string; label: string; detail?: string }
export interface DeploymentResult { taskId: string }
/** Optional port enumeration contributed by a deployment plugin, shown in the deploy dialog. */
export interface DeploymentPortSource { list: () => Promise<TransportPort[]> }
/** Optional monitor hand-off contributed by a deployment plugin after the command finishes. */
export interface DeploymentMonitor {
  label: string;
  transportId: string;
  defaultBaudRate: string;
  connect: (address: string, baudRate: string) => Promise<void>;
}
export interface TransportOptions { address: string; parameters: Record<string, string> }
export interface TransportParameter { key: string; label: string; type: "text" | "number"; initial: string; min?: number }
export interface TransportHandlers { data: (bytes: Uint8Array) => void; error: (message: string) => void; closed: () => void }
export interface TransportConnection { label: string; write: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void> }
export interface EditorAttachment {
  monaco: typeof import("monaco-editor"); editor: import("monaco-editor").editor.IStandaloneCodeEditor;
  model: import("monaco-editor").editor.ITextModel; file: string; root: string;
}
export interface CapabilityMap {
  terminals: { id: string; name: string; start: (root: string) => Promise<void>; stop: () => Promise<void>; interrupt: () => Promise<void>; clear: () => Promise<void>; mount: (element: HTMLElement) => () => void };
  languages: { id: string; name: string; languageIds: string[]; diagnosticsPanel: string; start: (root: string) => Promise<void>; stop: () => Promise<void>; restart?: () => Promise<void>; attach: (attachment: EditorAttachment) => () => void };
  deployments: { id: string; name: string; toolchain: string; endpointLabel: string; ports?: DeploymentPortSource; monitor?: DeploymentMonitor; deploy: (project: ProjectContext, address: string, options?: Record<string, string>) => Promise<DeploymentResult | void> };
  /** Read-only device identification and deploy preflight. Registered by a device plugin, never hardcoded in the host. */
  devices: { id: string; name: string; inspect: (port: string) => Promise<EspInspectResult>; preflight: (options: { environment: string; port: string; allow?: EspPreflightAllow }) => Promise<EspPreflightResult> };
  transports: { id: string; name: string; unavailable?: string; endpoint: { label: string; placeholder: string }; parameters: TransportParameter[]; description: string; sendHint: string; list?: () => Promise<TransportPort[]>; connect: (options: TransportOptions, handlers: TransportHandlers, signal?: AbortSignal) => Promise<TransportConnection> };
  boards: { id: string; name: string; component: string; description: string };
  components: PartDefinition;
  editors: { id: string; name: string; render: ComponentType<{ file: string }> };
  toolchains: { id: string; name: string; files: () => Record<string, string>; check: (project: ProjectContext) => string[]; build?: (project: ProjectContext) => Promise<void> };
  simulators: { id: string; name: string; start: (project: ProjectContext) => string[]; tick: (project: ProjectContext, elapsed: number) => SimulationFrame };
  agents: { id: string; name: string; run: (project: ProjectContext, messages: AIMessage[], signal?: AbortSignal, onTool?: (run: ToolRun) => void) => Promise<AgentResult> };
  tools: { id: string; name: string; description: string; parameters: Record<string, unknown>; execute: (args: unknown, project: ProjectContext) => { output: unknown; proposal?: EditProposal } | Promise<{ output: unknown; proposal?: EditProposal }> };
  providers: { id: string; name: string; complete: (messages: AIMessage[], signal?: AbortSignal) => Promise<string>; chat: (messages: AIMessage[], tools: CapabilityMap["tools"][], signal?: AbortSignal) => Promise<AIMessage> };
  templates: { id: string; name: string; description: string; board: string; create: () => ProjectWorkspace };
  projectFormats: { id: string; name: string; encode: (project: ProjectContext) => string; decode: (content: string) => ProjectContext };
  commands: { id: string; name: string; shortcut?: string; run: () => void | Promise<void> };
  overlays: { id: string; simulator?: string; render: ComponentType<{ readings: PartViewProps["readings"]; running: boolean }> };
  panels: { id: string; name: string; render: ComponentType };
  explorers: { id: string; name: string; render: ComponentType };
  dialogs: { id: string; name: string; render: ComponentType };
  menus: { id: string; name: string; command: string; location?: "project" | "share" | "plugins" };
}
export interface PluginHost {
  openProjectFolder: () => Promise<void>;
  saveProjectFolder: () => Promise<void>;
  reloadProjectFolder: () => Promise<void>;
  buildProject: () => Promise<void>;
  getProject: () => ProjectContext;
  log: (text: string) => void;
  importProject: (project: ProjectContext) => void;
  notify: (title: string, detail: string) => void;
  runSimulation: () => void;
  createProject: (board: string, template: string) => void;
}
export interface PluginAPI {
  readonly manifest: PluginManifest;
  readonly project: { get: () => ProjectContext };
  capabilities: { all: <K extends keyof CapabilityMap>(kind: K) => CapabilityMap[K][]; require: <K extends keyof CapabilityMap>(kind: K, id: string) => CapabilityMap[K] };
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
