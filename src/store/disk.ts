import { create } from "zustand";
import { isDesktop } from "../lib/desktop";
import { useStudio } from "./studio";
import { useTransport } from "./transport";
import type { DiskWorkspace, TaskSnapshot } from "../../shared/desktop";
import { plugins } from "../plugins/runtime";
interface DiskState {
  root: string | null; changed: boolean; busy: boolean; tasks: TaskSnapshot[]; error: string;
  adopt: (disk: DiskWorkspace) => void; open: () => Promise<void>; saveAs: () => Promise<void>; reload: () => Promise<void>;
  save: () => Promise<void>; detach: () => void; build: (provider: string, options?: Record<string, string>) => Promise<void>; cancel: (id: string) => Promise<void>;
}
const desktop = () => { if (!isDesktop()) throw new Error("此功能需要 Electron 桌面端"); return window.aether!; };
export const useDisk = create<DiskState>((set, get) => ({
  root: null, changed: false, busy: false, tasks: [], error: "",
  adopt: ({ root, context }) => {
    const { project, ...workspace } = context;
    useStudio.getState().cancelAgent(); void useTransport.getState().disconnect();
    useStudio.setState({ projects: [project], activeProjectId: project.id, workspaces: { [project.id]: workspace }, ...workspace, activeTab: "circuit", activeNav: "circuit", openTabs: ["circuit", ...Object.keys(workspace.files).filter((name) => name !== "circuit.json").slice(0, 1), "serial"], dirty: false, dialog: null, selectedId: null, selectedPin: null, libraryOpen: false, runState: "idle", elapsed: 0, serial: [], console: [], agentMessages: [], proposalReview: null });
    set({ root, changed: false, error: "" }); plugins.emit("project:opened", { root, id: project.id });
  },
  open: async () => { set({ busy: true }); try { const result = await desktop().workspace.open(); if (result) get().adopt(result); } finally { set({ busy: false }); } },
  saveAs: async () => { set({ busy: true }); try { const result = await desktop().workspace.saveAs(useStudio.getState().getProjectContext()); if (result) get().adopt(result); } finally { set({ busy: false }); } },
  reload: async () => { set({ busy: true }); try { get().adopt(await desktop().workspace.reload()); } finally { set({ busy: false }); } },
  save: async () => {
    const state = useStudio.getState(); const context = state.getProjectContext();
    await desktop().workspace.save(context);
    const current = useStudio.getState();
    if (current.files === state.files && current.components === state.components && current.wires === state.wires) useStudio.setState({ dirty: false });
    set({ changed: false, error: "" }); plugins.emit("project:saved", { root: get().root, id: context.project.id });
  },
  detach: () => { if (!get().root) return; set({ root: null, changed: false }); void desktop().workspace.close().catch((error) => set({ error: String(error) })); },
  build: async (provider, options) => {
    if (!get().root) throw new Error("请先使用 Save project to folder 保存到磁盘，或打开工程目录");
    await get().save();
    await useTransport.getState().disconnect();
    const task = await desktop().tasks.start(provider, options);
    set((s) => ({ error: "", tasks: [...s.tasks.filter((old) => old.id !== task.id), task] }));
  },
  cancel: async (id) => { await desktop().tasks.cancel(id); },
}));
export function connectDesktop() {
  if (!isDesktop()) return () => {};
  const api = desktop(); let current = true;
  let dirty = useStudio.getState().dirty;
  void api.workspace.setDirty(dirty);
  const offDirty = useStudio.subscribe((state) => { if (state.dirty !== dirty) { dirty = state.dirty; void api.workspace.setDirty(dirty); } });
  const offWorkspace = api.workspace.onChanged((root) => { if (useDisk.getState().root === root) useDisk.setState({ changed: true }); });
  const offTasks = api.tasks.onChanged((task) => useDisk.setState((s) => ({ tasks: [...s.tasks.filter((old) => old.id !== task.id), task] })));
  void api.workspace.restore().then((result) => { if (current && result) useDisk.getState().adopt(result); }).catch((error) => { if (current) useDisk.setState({ error: "重新打开工程失败：" + String(error) }); });
  void api.tasks.list().then((tasks) => { if (current) useDisk.setState((s) => ({ tasks: [...tasks.filter((task) => !s.tasks.some((old) => old.id === task.id)), ...s.tasks] })); });
  return () => { current = false; offDirty(); offWorkspace(); offTasks(); };
}
