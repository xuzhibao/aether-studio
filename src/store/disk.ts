import { create } from "zustand";
import { isDesktop } from "../lib/desktop";
import { useStudio } from "./studio";
import { useTransport } from "./transport";
import type { DiskWorkspace, TaskSnapshot, TaskEnvironment } from "../../shared/desktop";
import { plugins } from "../plugins/runtime";
export type DiskChangeKind = "modified" | "deleted" | "added";
export interface DiskChange { file: string; kind: DiskChangeKind; disk: string | null; local: string | null; dirty: boolean }
interface DiskState {
  root: string | null; changed: boolean; busy: boolean; tasks: TaskSnapshot[]; error: string;
  environments: TaskEnvironment[]; environment: string;
  loadEnvironments: (provider?: string) => Promise<void>; setEnvironment: (name: string) => void; adoptTaskEnvironment: (name: string) => Promise<void>;
  directories: string[]; synced: Record<string, string>; diskFiles: Record<string, string>;
  adopt: (disk: DiskWorkspace) => void; open: () => Promise<void>; saveAs: () => Promise<void>; reload: () => Promise<void>;
  save: () => Promise<void>; detach: () => void; build: (provider: string, options?: Record<string, string>) => Promise<void>; cancel: (id: string) => Promise<void>;
  refresh: () => Promise<void>; acceptDisk: (file: string) => Promise<void>; keepLocal: (file: string) => Promise<void>; saveFile: (file: string) => Promise<void>;
}
const desktop = () => { if (!isDesktop()) throw new Error("此功能需要 Electron 桌面端"); return window.aether!; };
// The virtual circuit view mirrors components/wires; the host writes it as part of a project save.
const persisted = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([name]) => name !== "circuit.json"));

/** Per-file comparison between the last synced disk content and the current disk content. */
export function diskChanges(): DiskChange[] {
  const { synced, diskFiles } = useDisk.getState();
  const files = useStudio.getState().files;
  const names = new Set([...Object.keys(synced), ...Object.keys(diskFiles)]);
  const result: DiskChange[] = [];
  for (const name of [...names].sort()) {
    if (name === "circuit.json") continue;
    const disk = Object.hasOwn(diskFiles, name) ? diskFiles[name] : null;
    const base = Object.hasOwn(synced, name) ? synced[name] : null;
    if (disk === base) continue;
    const local = Object.hasOwn(files, name) ? files[name] : null;
    result.push({ file: name, kind: base === null ? "added" : disk === null ? "deleted" : "modified", disk, local, dirty: local !== null && local !== base });
  }
  return result;
}
export const useDisk = create<DiskState>((set, get) => {
  const recompute = () => set({ changed: diskChanges().length > 0 });
  // Responses are tied to the project and refresh that requested them; a slower answer must not win.
  let environmentRequest = 0;
  return {
  root: null, changed: false, busy: false, tasks: [], error: "", environments: [], environment: "", directories: [], synced: {}, diskFiles: {},
  adopt: ({ root, context, directories }) => {
    const { project, ...workspace } = context;
    useStudio.getState().cancelAgent(); void useTransport.getState().disconnect();
    useStudio.setState({ projects: [project], activeProjectId: project.id, workspaces: { [project.id]: workspace }, ...workspace, activeTab: "circuit", activeNav: "circuit", openTabs: ["circuit", ...Object.keys(workspace.files).filter((name) => name !== "circuit.json").slice(0, 1), "serial"], dirty: false, dialog: null, selectedId: null, selectedPin: null, libraryOpen: false, runState: "idle", elapsed: 0, serial: [], console: [], agentMessages: [], proposalReview: null });
    const synced = persisted(workspace.files);
    set({ root, changed: false, error: "", environments: [], environment: "", directories: directories ?? [], synced, diskFiles: synced }); plugins.emit("project:opened", { root, id: project.id });
  },
  open: async () => { set({ busy: true }); try { const result = await desktop().workspace.open(); if (result) get().adopt(result); } finally { set({ busy: false }); } },
  saveAs: async () => { set({ busy: true }); try { const result = await desktop().workspace.saveAs(useStudio.getState().getProjectContext()); if (result) get().adopt(result); } finally { set({ busy: false }); } },
  reload: async () => { set({ busy: true }); try { get().adopt(await desktop().workspace.reload()); } finally { set({ busy: false }); } },
  save: async () => {
    const state = useStudio.getState(); const context = state.getProjectContext();
    await desktop().workspace.save(context);
    const current = useStudio.getState();
    if (current.files === state.files && current.components === state.components && current.wires === state.wires) useStudio.setState({ dirty: false });
    // Use the snapshot that was actually written; a buffer edited during the await stays dirty.
    const synced = persisted(context.files);
    set((s) => ({ changed: false, error: "", synced, diskFiles: { ...s.diskFiles, ...synced } }));
    plugins.emit("project:saved", { root: get().root, id: context.project.id });
    await get().refresh();
  },
  detach: () => { if (!get().root) return; set({ root: null, changed: false, environments: [], environment: "", directories: [], synced: {}, diskFiles: {} }); void desktop().workspace.close().catch((error) => set({ error: String(error) })); },
  refresh: async () => {
    if (!get().root || !isDesktop()) return;
    const listing = await desktop().workspace.files.listing();
    const files = useStudio.getState().files;
    const synced = { ...get().synced };
    // A file that already matches the buffer needs no manual decision.
    for (const [name, text] of Object.entries(listing.files)) if (Object.hasOwn(files, name) && files[name] === text) synced[name] = text;
    set({ directories: listing.directories, diskFiles: listing.files, synced, error: "" });
    recompute();
  },
  acceptDisk: async (file) => {
    const change = diskChanges().find((item) => item.file === file);
    if (!change) return;
    // The host baseline must accept the disk content too, otherwise the next whole-project save would refuse.
    await desktop().workspace.files.accept(file);
    if (change.kind === "deleted") {
      useStudio.getState().removePaths([file]);
      set((s) => { const synced = { ...s.synced }; delete synced[file]; const diskFiles = { ...s.diskFiles }; delete diskFiles[file]; return { synced, diskFiles }; });
    } else {
      const text = change.disk ?? "";
      useStudio.setState((s) => ({ files: { ...s.files, [file]: text } }));
      set((s) => ({ synced: { ...s.synced, [file]: text }, diskFiles: { ...s.diskFiles, [file]: text } }));
      if (change.kind === "added") useStudio.getState().openFile(file);
    }
    recompute();
  },
  keepLocal: async (file) => {
    const change = diskChanges().find((item) => item.file === file);
    if (!change) return;
    const local = useStudio.getState().files[file];
    if (local === undefined) throw new Error("本地缓冲区没有此文件，无法覆盖磁盘：" + file);
    // The previewed disk text is the precondition: a second external change is refused instead of overwritten.
    await desktop().workspace.files.write(file, local, change.disk);
    const wasDirty = local !== (Object.hasOwn(get().synced, file) ? get().synced[file] : "");
    set((s) => ({ synced: { ...s.synced, [file]: local }, diskFiles: { ...s.diskFiles, [file]: local }, error: "" }));
    if (wasDirty) useStudio.setState({ dirty: true });
    recompute();
  },
  saveFile: async (file) => {
    const text = useStudio.getState().files[file];
    if (text === undefined) throw new Error("本地缓冲区没有此文件：" + file);
    const expected = Object.hasOwn(get().diskFiles, file) ? get().diskFiles[file] : null;
    await desktop().workspace.files.write(file, text, expected);
    set((s) => ({ synced: { ...s.synced, [file]: text }, diskFiles: { ...s.diskFiles, [file]: text }, error: "" }));
    recompute();
  },
  loadEnvironments: async (provider = "platformio.build") => {
    const root = get().root;
    if (!root || !isDesktop()) return;
    const request = ++environmentRequest;
    const environments = await desktop().tasks.environments(provider);
    if (request !== environmentRequest || get().root !== root) return;
    // While a task runs its environment is fixed; refreshing may update the list but never the selection.
    if (get().tasks.some((task) => task.status === "running")) { set({ environments }); return; }
    const current = get().environment;
    const environment = environments.some((item) => item.name === current) ? current : (environments.find((item) => item.default) ?? environments[0])?.name ?? "";
    set({ environments, environment });
  },
  setEnvironment: (name) => {
    const state = get();
    if (state.tasks.some((task) => task.status === "running")) throw new Error("任务运行中，请等待或取消后再切换环境");
    if (!state.environments.some((item) => item.name === name)) throw new Error("未知的构建环境：" + name);
    set({ environment: name });
  },
  // A task started from the toolbar fixes its environment before the Build Tasks panel ever loads the list.
  adoptTaskEnvironment: async (name) => {
    const root = get().root;
    if (!name || !root || get().environment) return;
    await get().loadEnvironments();
    if (get().root === root && get().environments.some((item) => item.name === name)) set({ environment: name });
  },
  build: async (provider, options) => {
    if (!get().root) throw new Error("请先使用 Save project to folder 保存到磁盘，或打开工程目录");
    await get().save();
    await useTransport.getState().disconnect();
    // PlatformIO 的构建、上传和编译数据库共用当前选定的环境，避免产物和数据库串用。
    const environment = get().environment;
    const task = await desktop().tasks.start(provider, provider.startsWith("platformio.") && environment ? { ...options, environment } : options);
    set((s) => ({ error: "", tasks: [...s.tasks.filter((old) => old.id !== task.id), task] }));
  },
  cancel: async (id) => { await desktop().tasks.cancel(id); },
  };
});
export function connectDesktop() {
  if (!isDesktop()) return () => {};
  const api = desktop(); let current = true;
  let dirty = useStudio.getState().dirty;
  void api.workspace.setDirty(dirty);
  const offDirty = useStudio.subscribe((state) => { if (state.dirty !== dirty) { dirty = state.dirty; void api.workspace.setDirty(dirty); } });
  const offWorkspace = api.workspace.onChanged((root) => { if (useDisk.getState().root === root) { useDisk.setState({ changed: true }); void useDisk.getState().refresh().catch(() => {}); } });
  const offTasks = api.tasks.onChanged((task) => {
    useDisk.setState((s) => ({ tasks: [...s.tasks.filter((old) => old.id !== task.id), task] }));
    if (task.environment) void useDisk.getState().adoptTaskEnvironment(task.environment).catch((error) => useDisk.setState({ error: String(error) }));
  });
  void api.workspace.restore().then((result) => { if (current && result) useDisk.getState().adopt(result); }).catch((error) => { if (current) useDisk.setState({ error: "重新打开工程失败：" + String(error) }); });
  void api.tasks.list().then((tasks) => { if (current) useDisk.setState((s) => ({ tasks: [...tasks.filter((task) => !s.tasks.some((old) => old.id === task.id)), ...s.tasks] })); });
  return () => { current = false; offDirty(); offWorkspace(); offTasks(); };
}
