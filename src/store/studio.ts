import { useDisk, isActionCancelled } from "./disk";
import { useTransport } from "./transport";
import { readLayout, writeLayout, defaultLayout } from "../lib/workspacePreferences";
import { create } from "zustand";
import type {
  AgentMessage,
  ComponentKind,
  ConsoleLine,
  DockTab,
  HwComponent,
  ProjectMeta,
  RunState,
  SerialLine,
  Step,
  Toast,
  Tool,
  ViewMode,
  Wire,
} from "../types";
import { plugins } from "../plugins/runtime";
import type { ProjectContext, ProjectWorkspace } from "../plugins/api";
import { clamp, simTime, uid } from "../lib/utils";

export type DialogKind = "new-project" | "deploy" | "devices" | "tests" | "overview" | "plugins" | "review-changes" | "new-file" | null;

type WorkspaceSnapshot = ProjectWorkspace;

interface NewProjectInput {
  name: string;
  board: string;
  template: string;
}

interface StudioState {
  projects: ProjectMeta[];
  activeProjectId: string;
  workspaces: Record<string, WorkspaceSnapshot>;
  components: HwComponent[];
  wires: Wire[];
  files: Record<string, string>;
  capabilities: ProjectWorkspace["capabilities"];

  activeNav: string;
  activeTab: string;
  openTabs: string[];
  dirty: boolean;

  sidebarCollapsed: boolean;
  sidebarWidth: number;
  agentWidth: number;
  agentCollapsed: boolean;
  dockOpen: boolean;
  dockHeight: number;
  dockTab: DockTab;
  splitMode: boolean;
  splitRatio: number;

  selectedId: string | null;
  selectedPin: string | null;
  inspectorTab: "properties" | "pins";
  tool: Tool;
  viewMode: ViewMode;
  wireStart: { comp: string; pin: string } | null;
  zoom: number;
  pan: { x: number; y: number };
  libraryOpen: boolean;

  runState: RunState;
  elapsed: number;
  readings: { temperature: number; humidity: number; pressure: number };
  ledOn: boolean;
  serial: SerialLine[];
  console: ConsoleLine[];
  errors: number;
  warnings: number;
  cpu: number;
  memory: number;

  agentMessages: AgentMessage[];
  agentRunning: boolean;
  activeAgentId: string;
  proposalReview: { messageId: string; proposalId: string } | null;
  agentDraft: string;
  aiModifiedFiles: string[];
  appliedFixIds: string[];

  dialog: DialogKind;
  commandOpen: boolean;
  toasts: Toast[];
  settings: { reducedMotion: boolean; autopilot: boolean; fontSize: number };

  setActiveNav: (nav: string) => void;
  setTab: (tab: string) => void;
  openFile: (file: string) => void;
  closeTab: (tab: string) => void;
  updateFile: (name: string, value: string) => void;
  renamePath: (from: string, to: string) => void;
  removePaths: (paths: string[]) => void;
  saveProject: () => void;
  getProjectContext: () => ProjectContext;

  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (v: number) => void;
  setAgentWidth: (v: number) => void;
  setAgentCollapsed: (v: boolean) => void;
  setDockOpen: (v: boolean) => void;
  setDockHeight: (v: number) => void;
  setDockTab: (tab: DockTab) => void;
  setSplitMode: (v: boolean) => void;
  setSplitRatio: (v: number) => void;
  saveLayout: () => void;
  resetLayout: () => void;

  selectComponent: (id: string | null) => void;
  selectPin: (comp: string, pin: string) => void;
  setInspectorTab: (tab: "properties" | "pins") => void;
  setTool: (tool: Tool) => void;
  setViewMode: (mode: ViewMode) => void;
  setZoom: (z: number) => void;
  setPan: (p: { x: number; y: number }) => void;
  resetView: () => void;
  moveComponent: (id: string, x: number, y: number) => void;
  addComponent: (kind: ComponentKind) => void;
  removeComponent: (id: string) => void;
  startWire: (comp: string, pin: string) => void;
  completeWire: (comp: string, pin: string) => void;
  cancelWire: () => void;
  setLibraryOpen: (v: boolean) => void;
  setDialog: (dialog: DialogKind) => void;
  setCommandOpen: (v: boolean) => void;

  setRunState: (state: RunState) => void;
  runSimulation: () => void;
  pauseSimulation: () => void;
  resetSimulation: () => void;
  tick: () => void;
  build: () => Promise<void>;

  setAgentDraft: (v: string) => void;
  runAgent: (prompt?: string) => Promise<void>;
  applyFix: (messageId: string) => void;
  setAgent: (id: string) => void;
  cancelAgent: () => void;
  reviewProposal: (messageId: string, proposalId: string) => void;
  resolveProposal: (messageId: string, proposalId: string, apply: boolean) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  importProject: (project: ProjectContext) => void;
  createProject: (input: NewProjectInput) => void;
  switchProject: (id: string) => void;
  updateSettings: (partial: Partial<StudioState["settings"]>) => void;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const colorBySignal = { power: "#E15B4F", gnd: "#41464F", i2c: "#2F7FD8", gpio: "#3B9A68", analog: "#8A6DCC", pwm: "#D9962F" };

const navForTab = (tab: string) => {
  if (tab === "circuit") return "circuit";
  if (tab === "serial") return "simulation";
  return "source";
};

const storageKey = "aether.projects.v1";
const baseWorkspace = (): WorkspaceSnapshot => {
  const template = plugins.all("templates")[0];
  return template ? template.create() : { components: [], wires: [], files: {}, capabilities: { board: "", toolchain: "", simulator: "", editor: "" } };
};
const snapshot = (s: StudioState): WorkspaceSnapshot => ({ components: s.components, wires: s.wires, files: s.files, capabilities: s.capabilities });
let loadError = "";
function loadProjects(): { projects: ProjectMeta[]; activeProjectId: string; workspaces: Record<string, WorkspaceSnapshot> } {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !saved.projects?.length || !saved.workspaces[saved.activeProjectId]) throw new Error("不支持的工程存储格式");
      return saved;
    }
  } catch (error) { loadError = `读取工程失败：${error instanceof Error ? error.message : String(error)}。原始存储未被覆盖。`; }
  return {
    projects: [{ id: "env-monitor", name: plugins.all("templates")[0]?.name ?? "Workspace", description: "本地示例工程", board: plugins.all("boards")[0]?.name ?? "未选择开发板", template: plugins.all("templates")[0]?.id ?? "", accent: "#007AFF", updated: "示例" }],
    activeProjectId: "env-monitor", workspaces: { "env-monitor": baseWorkspace() },
  };
}
const preferences = readLayout();
const saved = loadProjects();
const initial = saved.workspaces[saved.activeProjectId];
const reportError = (error: unknown) => useStudio.getState().addToast({ title: "操作失败", detail: error instanceof Error ? error.message : String(error), tone: "warn" });
function withCapability(action: () => void) { try { action(); } catch (error) { reportError(error); } }

let currentAgentRun: { controller: AbortController; messageId: string } | null = null;
const welcomeMessage: AgentMessage = { id: "welcome", role: "agent", time: "now", text: "在 Plugins 配置 AI API 后可进行工程问答。Project Tools 模式可以读取工程并提出文件修改，修改需预览后手动应用。发送时会将当前工程上下文传给配置的 API。" };

export const useStudio = create<StudioState>((set, get) => ({
  projects: saved.projects,
  activeProjectId: saved.activeProjectId,
  workspaces: saved.workspaces,
  ...clone(initial),

  activeNav: "circuit",
  activeTab: "circuit",
  openTabs: ["circuit", "main.py", "serial"],
  dirty: false,

  selectedId: null,
  selectedPin: null,
  inspectorTab: "properties",
  tool: "select",
  viewMode: "board",
  wireStart: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  libraryOpen: false,

  runState: "idle",
  elapsed: 0,
  readings: { temperature: 24.6, humidity: 48.2, pressure: 1013.2 },
  ledOn: true,
  serial: [],
  console: [{ id: "startup", source: "Simulator", text: loadError || preferences.error || "Demo Simulation · 生成数据演示；不执行固件、不连接真实硬件。", tone: loadError || preferences.error ? "warn" : "muted" }],
  errors: 0,
  warnings: 0,
  cpu: 38,
  memory: 38,

  agentMessages: [welcomeMessage],
  agentRunning: false,
  activeAgentId: plugins.all("agents")[0]?.id ?? "",
  proposalReview: null,
  agentDraft: "",
  aiModifiedFiles: [],
  appliedFixIds: [],

  dialog: null,
  commandOpen: false,
  toasts: [],
  ...preferences.layout,

  setActiveNav: (nav) => {
    set({ activeNav: nav });
    if (nav === "plugins") set({ dialog: "plugins" });
    if (nav === "overview") set({ dialog: "overview" });
    if (nav === "hardware") {
      set({ activeTab: "circuit", selectedId: "board-1", tool: "select" });
    }
    if (nav === "circuit") set({ activeTab: "circuit" });
    if (nav === "source") get().openFile(Object.keys(get().files).find((name) => /\.(py|cpp|c)$/.test(name)) ?? Object.keys(get().files)[0]);
    if (nav === "components") set({ activeTab: "circuit", libraryOpen: true });
    if (nav === "simulation") set({ activeTab: "serial" });
    if (nav === "devices") set({ dialog: "devices" });
    if (nav === "tests") set({ dialog: "tests" });
  },
  setTab: (tab) => set((s) => ({ activeTab: tab, activeNav: navForTab(tab), libraryOpen: false, openTabs: s.openTabs.includes(tab) ? s.openTabs : [...s.openTabs, tab] })),
  openFile: (file) => {
    if (file === "circuit.json") set((s) => ({ files: { ...s.files, "circuit.json": JSON.stringify({ components: s.components, wires: s.wires }, null, 2) } }));
    set((s) => ({
      activeTab: file,
      activeNav: navForTab(file),
      openTabs: s.openTabs.includes(file) ? s.openTabs : [...s.openTabs, file],
      libraryOpen: false,
    }));
  },
  closeTab: (tab) => {
    if (tab === "circuit" || tab === "serial") return;
    set((s) => {
      const tabs = s.openTabs.filter((t) => t !== tab);
      return {
        openTabs: tabs,
        activeTab: s.activeTab === tab ? tabs[tabs.length - 1] ?? "circuit" : s.activeTab,
      };
    });
  },
  updateFile: (name, value) =>
    set((s) => ({
      files: { ...s.files, [name]: value },
      dirty: true,
      aiModifiedFiles: s.aiModifiedFiles,
    })),
  renamePath: (from, to) =>
    set((s) => {
      const rename = (name: string) => name === from ? to : name.startsWith(from + "/") ? to + name.slice(from.length) : name;
      return {
        files: Object.fromEntries(Object.entries(s.files).map(([name, text]) => [rename(name), text])),
        openTabs: s.openTabs.map(rename),
        aiModifiedFiles: s.aiModifiedFiles.map(rename),
        activeTab: rename(s.activeTab),
      };
    }),
  removePaths: (paths) =>
    set((s) => {
      const match = (name: string) => paths.some((item) => name === item || name.startsWith(item + "/"));
      const openTabs = s.openTabs.filter((tab) => !match(tab));
      return {
        files: Object.fromEntries(Object.entries(s.files).filter(([name]) => !match(name))),
        openTabs,
        aiModifiedFiles: s.aiModifiedFiles.filter((name) => !match(name)),
        activeTab: match(s.activeTab) ? openTabs[openTabs.length - 1] ?? "circuit" : s.activeTab,
      };
    }),
  getProjectContext: () => ({ ...snapshot(get()), project: get().projects.find((p) => p.id === get().activeProjectId)! }),
  saveProject: () => {
    if (useDisk.getState().root) { void useDisk.getState().save().catch(reportError); return; }
    const s = get();
    const files = { ...s.files, "circuit.json": JSON.stringify({ components: s.components, wires: s.wires }, null, 2) };
    const workspaces = { ...s.workspaces, [s.activeProjectId]: { ...snapshot(s), files } };
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, projects: s.projects, activeProjectId: s.activeProjectId, workspaces }));
      set({ workspaces, files, dirty: false });
      plugins.emit("project:saved", { id: s.activeProjectId });
      get().addToast({ title: "Project saved", detail: "工程、电路和代码已保存到本机", tone: "success" });
    } catch (error) { set({ dirty: true }); reportError(error); }
  },

  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setSidebarWidth: (v) => set({ sidebarWidth: clamp(v, 208, 304) }),
  setAgentWidth: (v) => set({ agentWidth: clamp(v, 316, 470) }),
  setAgentCollapsed: (v) => set({ agentCollapsed: v }),
  setDockOpen: (v) => set({ dockOpen: v }),
  setDockHeight: (v) => set({ dockHeight: clamp(v, 128, 360) }),
  setDockTab: (tab) => set({ dockTab: tab, dockOpen: true }),
  setSplitMode: (v) => set({ splitMode: v }),
  setSplitRatio: (v) => set({ splitRatio: clamp(v, 36, 72) }),
  saveLayout: () => withCapability(() => { writeLayout(get()); get().addToast({ title: "布局已保存", detail: "面板尺寸、分屏和编辑器设置将在下次启动时恢复。", tone: "success" }); }),
  resetLayout: () => withCapability(() => { writeLayout(defaultLayout); set(structuredClone(defaultLayout)); }),

  selectComponent: (id) =>
    set({ selectedId: id, inspectorTab: "properties", libraryOpen: false, selectedPin: null }),
  selectPin: (comp, pin) => {
    const s = get();
    if (s.tool === "wire") {
      if (!s.wireStart) s.startWire(comp, pin);
      else s.completeWire(comp, pin);
    } else {
      set({ selectedId: comp, selectedPin: pin, inspectorTab: "pins" });
    }
  },
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  setTool: (tool) => set({ tool, wireStart: null, libraryOpen: tool === "add" ? true : get().libraryOpen }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setZoom: (z) => set({ zoom: clamp(z, 0.6, 2) }),
  setPan: (p) => set({ pan: p }),
  resetView: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
  moveComponent: (id, x, y) =>
    set((s) => ({
      components: s.components.map((c) => (c.id === id ? { ...c, x, y } : c)),
      dirty: true,
    })),
  addComponent: (kind) => withCapability(() => {
    const count = get().components.filter((c) => c.kind === kind).length;
    const part = plugins.require("components", kind).create(count);
    set((s) => ({
      components: [...s.components, part],
      selectedId: part.id,
      tool: "select",
      libraryOpen: false,
      activeTab: "circuit",
      activeNav: "circuit",
      dirty: true,
    }));
    get().addToast({ title: part.name + " added", detail: "Drag it onto the bench to place", tone: "success" });
  }),
  removeComponent: (id) => {
    if (id === "board-1") return;
    set((s) => ({
      components: s.components.filter((c) => c.id !== id),
      wires: s.wires.filter((w) => w.from.comp !== id && w.to.comp !== id),
      selectedId: null,
      dirty: true,
    }));
    get().addToast({ title: "Component removed", tone: "default" });
  },
  startWire: (comp, pin) => set({ wireStart: { comp, pin }, selectedPin: pin }),
  completeWire: (comp, pin) => {
    const start = get().wireStart;
    if (!start) return;
    if (start.comp === comp && start.pin === pin) {
      set({ wireStart: null });
      return;
    }
    const fromComp = get().components.find((c) => c.id === start.comp);
    const fromPin = fromComp?.pins.find((p) => p.id === start.pin);
    if (!fromComp || !fromPin) return;
    const signal =
      fromPin.signal === "power"
        ? "power"
        : fromPin.signal === "gnd"
          ? "gnd"
          : fromPin.signal === "i2c"
            ? start.pin === "l11" || start.pin === "sda"
              ? "sda"
              : "scl"
            : "gpio";
    const wire: Wire = {
      id: uid("wire"),
      from: start,
      to: { comp, pin },
      signal,
      color: colorBySignal[fromPin.signal] ?? "#41464F",
      lane: get().wires.length % 6,
    };
    set((s) => ({ wires: [...s.wires, wire], wireStart: null, selectedPin: null, dirty: true }));
    get().addToast({ title: "Connection added", detail: fromPin.label + " → " + pin.toUpperCase(), tone: "success" });
  },
  cancelWire: () => set({ wireStart: null, selectedPin: null }),
  setLibraryOpen: (v) => set({ libraryOpen: v }),
  setDialog: (dialog) => set({ dialog }),
  setCommandOpen: (v) => set({ commandOpen: v }),

  setRunState: (state) => { if (state === "running") get().runSimulation(); else set({ runState: state }); },
  runSimulation: () => withCapability(() => {
    const s = get();
    if (s.runState === "running") return;
    const simulator = plugins.require("simulators", s.capabilities.simulator);
    const lines = simulator.start(s.getProjectContext());
    set({ runState: "running", dockOpen: true, dockTab: "console", console: [...s.console, ...lines.map((text): ConsoleLine => ({ id: uid("c"), source: "Simulator", text, tone: "muted" }))] });
    plugins.emit("simulation:started", { projectId: s.activeProjectId });
  }),
  pauseSimulation: () => set({ runState: "paused" }),
  resetSimulation: () => { set({ runState: "idle", elapsed: 0, serial: [], ledOn: false }); get().runSimulation(); },
  tick: () => {
    const s = get();
    if (s.runState !== "running") return;
    withCapability(() => {
      const elapsed = s.elapsed + 1;
      const frame = plugins.require("simulators", s.capabilities.simulator).tick(s.getProjectContext(), elapsed);
      set({ elapsed, readings: frame.readings, ledOn: !s.ledOn, serial: [...s.serial, ...frame.lines.map((text): SerialLine => ({ id: uid("s"), time: simTime(elapsed), level: "data", text }))].slice(-90) });
    });
  },
  build: async () => {
    const s = get();
    try {
      const toolchain = plugins.require("toolchains", s.capabilities.toolchain);
      if (toolchain.build) { get().setTab("panel:build.tasks"); await toolchain.build(s.getProjectContext()); }
      else {
        const lines = toolchain.check(s.getProjectContext());
        set({ dockOpen: true, dockTab: "console", console: [...s.console, ...lines.map((text): ConsoleLine => ({ id: uid("c"), source: "Build", text, tone: "muted" }))] });
      }
    } catch (error) {
      // A pre-build review cancelled by the user is not a failure: nothing was created or flashed.
      if (isActionCancelled(error)) { get().addToast({ title: "已取消构建", detail: (error as Error).message, tone: "default" }); return; }
      useDisk.setState({ error: String(error) });
      reportError(error);
    }
  },
  setAgentDraft: (v) => set({ agentDraft: v }),
  setAgent: (id) => { get().cancelAgent(); set({ activeAgentId: id }); },
  cancelAgent: () => {
    const run = currentAgentRun;
    if (!run) return;
    currentAgentRun = null;
    run.controller.abort();
    set((s) => ({ agentRunning: false, agentMessages: s.agentMessages.map((m) => m.id === run.messageId ? { ...m, text: "请求已取消；未自动应用文件修改。", error: true } : m) }));
  },
  runAgent: async (prompt) => {
    const s = get();
    const text = (prompt ?? s.agentDraft).trim();
    if (!text || s.agentRunning) return;
    const id = uid("msg");
    const run = { controller: new AbortController(), messageId: id };
    currentAgentRun = run;
    const timeout = window.setTimeout(() => run.controller.abort(new Error("AI 请求超时")), 60000);
    set({ agentRunning: true, agentDraft: "", agentMessages: [...s.agentMessages, { id: uid("msg"), role: "user", time: "now", text }, { id, role: "agent", time: "now", text: "正在请求配置的 AI API…" }] });
    try {
      const agent = plugins.get("agents", s.activeAgentId);
      if (!agent) throw new Error("请先在 Plugins 启用并选择 Agent。");
      const history = s.agentMessages.filter((m) => m.id !== "welcome" && !m.error).map((m) => ({ role: m.role === "agent" ? "assistant" as const : "user" as const, content: m.text }));
      const reply = await agent.run(s.getProjectContext(), [...history, { role: "user", content: text }], run.controller.signal, (tool) => {
        if (currentAgentRun !== run) return;
        set((state) => ({ agentMessages: state.agentMessages.map((m) => m.id === id ? { ...m, toolRuns: [...(m.toolRuns ?? []), tool] } : m) }));
      });
      if (currentAgentRun !== run) return;
      set((state) => ({ agentMessages: state.agentMessages.map((m) => m.id === id ? { ...m, text: reply.text, proposals: reply.proposals, toolRuns: reply.toolRuns } : m) }));
    } catch (error) {
      if (currentAgentRun !== run) return;
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({ agentMessages: state.agentMessages.map((m) => m.id === id ? { ...m, error: true, text: `请求未完成：${message}` } : m) }));
    } finally {
      window.clearTimeout(timeout);
      if (currentAgentRun === run) { currentAgentRun = null; set({ agentRunning: false }); }
    }
  },
  applyFix: () => get().addToast({ title: "请选择修改建议", detail: "在 Agent 回复中打开文件修改预览。" }),
  reviewProposal: (messageId, proposalId) => set({ dialog: "review-changes", proposalReview: { messageId, proposalId } }),
  resolveProposal: (messageId, proposalId, apply) => withCapability(() => {
    const s = get();
    const proposal = s.agentMessages.find((m) => m.id === messageId)?.proposals?.find((p) => p.id === proposalId);
    if (!proposal || proposal.status !== "pending") return;
    if (apply) {
      if (proposal.projectId !== s.activeProjectId) throw new Error("修改建议不属于当前工程");
      for (const change of proposal.changes) if ((Object.hasOwn(s.files, change.path) ? s.files[change.path] : null) !== change.before) throw new Error(change.path + " 已被修改，请重新生成建议，避免覆盖现有编辑。");
    }
    const updates = Object.fromEntries(proposal.changes.map((c) => [c.path, c.after]));
    set({
      ...(apply ? { files: { ...s.files, ...updates }, dirty: true, aiModifiedFiles: [...new Set([...s.aiModifiedFiles, ...Object.keys(updates)])] } : {}),
      dialog: null, proposalReview: null,
      agentMessages: s.agentMessages.map((m) => m.id === messageId ? { ...m, proposals: m.proposals!.map((p) => p.id === proposalId ? { ...p, status: apply ? "applied" : "rejected" } : p) } : m),
      console: [...s.console, { id: uid("c"), source: "Agent", text: apply ? "已应用审阅后的文件修改：" + Object.keys(updates).join(", ") + "；尚未保存、编译或执行。" : "已拒绝文件修改建议。", tone: "normal" }],
    });
  }),
  addToast: (toast) => {
    const id = uid("toast");
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }].slice(-3) }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  switchProject: (id) => {
    const s = get();
    if (id === s.activeProjectId) return;
    useDisk.getState().detach();
    get().cancelAgent();
    void useTransport.getState().disconnect();
    const currentSnapshot = snapshot(s);
    const existing = s.workspaces[id];
    const target = existing!;
    const project = s.projects.find((p) => p.id === id);
    set({
      workspaces: { ...s.workspaces, [s.activeProjectId]: currentSnapshot, [id]: target },
      activeProjectId: id,
      agentMessages: [welcomeMessage],
      proposalReview: null,
      components: clone(target.components),
      wires: clone(target.wires),
      files: { ...target.files },
      capabilities: target.capabilities,
      activeTab: "circuit",
      activeNav: "circuit",
      openTabs: ["circuit", "main.py", "serial"],
      selectedId: null,
      dirty: false,
      dialog: null,
      elapsed: 0,
      serial: [],
      console: [],
      runState: "idle",
    });
    get().saveProject();
  },

  importProject: (context) => {
    const s = get();
    const id = uid("project");
    const { project: source, ...content } = clone(context);
    const meta: ProjectMeta = { ...source, id, updated: "Just now" };
    const files = { ...content.files, "circuit.json": JSON.stringify({ components: content.components, wires: content.wires }, null, 2) };
    const workspace = { ...content, files };
    const projects = [...s.projects, meta];
    const workspaces = { ...s.workspaces, [s.activeProjectId]: snapshot(s), [id]: workspace };
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, projects, activeProjectId: id, workspaces }));
    useDisk.getState().detach();
    get().cancelAgent();
    void useTransport.getState().disconnect();
    set({ agentMessages: [welcomeMessage], proposalReview: null, projects, workspaces, activeProjectId: id, ...workspace, activeTab: "circuit", activeNav: "circuit", openTabs: ["circuit", ...Object.keys(files).filter((f) => f !== "circuit.json").slice(0, 1), "serial"], dirty: false, dialog: null, selectedId: null, selectedPin: null, libraryOpen: false, runState: "idle", elapsed: 0, serial: [], console: [] });
    plugins.emit("project:imported", { id });
  },

  createProject: (input) => withCapability(() => {
    const s = get();
    const id = uid("project");
    const selectedBoard = plugins.require("boards", input.board);
    const selectedTemplate = plugins.require("templates", input.template);
    if (selectedTemplate.board !== selectedBoard.id) throw new Error("此模板不支持所选开发板");
    const meta: ProjectMeta = {
      id,
      name: input.name || "Untitled Project",
      description: "A new hardware workspace created in Aether Studio.",
      board: selectedBoard.name,
      updated: "Just now",
      accent: "#007AFF",
      template: input.template,
    };
    const currentSnapshot = snapshot(s);
    const workspace = selectedTemplate.create();
    useDisk.getState().detach();
    get().cancelAgent();
    void useTransport.getState().disconnect();
    set({
      projects: [...s.projects, meta],
      workspaces: { ...s.workspaces, [s.activeProjectId]: currentSnapshot, [id]: workspace },
      activeProjectId: id,
      agentMessages: [welcomeMessage],
      proposalReview: null,
      components: clone(workspace.components),
      wires: clone(workspace.wires),
      files: { ...workspace.files },
      capabilities: workspace.capabilities,
      activeTab: "circuit",
      activeNav: "circuit",
      openTabs: ["circuit", "main.py", "serial"],
      selectedId: null,
      dirty: false,
      dialog: null,
      elapsed: 0,
      serial: [],
      console: [],
      runState: "idle",
      selectedPin: null,
      libraryOpen: false,
    });
    get().saveProject();
    plugins.emit("project:created", { id, board: selectedBoard.id });
  }),

  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
}));

plugins.connect({
  openProjectFolder: () => useDisk.getState().open(), saveProjectFolder: () => useDisk.getState().saveAs(), reloadProjectFolder: () => useDisk.getState().reload(), buildProject: () => useStudio.getState().build(),
  getProject: () => useStudio.getState().getProjectContext(),
  importProject: (project) => useStudio.getState().importProject(project),
  notify: (title, detail) => useStudio.getState().addToast({ title, detail }),
  log: (text) => useStudio.setState((s) => ({ console: [...s.console, { id: uid("plugin"), source: "Plugin", text }], dockOpen: true, dockTab: "console" })),
  runSimulation: () => useStudio.getState().runSimulation(),
  createProject: (board, template) => useStudio.getState().createProject({ name: "ESP32-S3 Demo", board, template }),
});
plugins.on("plugin:disabled", () => {
  if (!plugins.get("simulators", useStudio.getState().capabilities.simulator)) useStudio.setState({ runState: "idle" });
  if (!plugins.get("agents", useStudio.getState().activeAgentId)) useStudio.getState().cancelAgent();
});
