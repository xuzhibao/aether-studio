import { create } from "zustand";
import { isDesktop } from "../lib/desktop";
import { useStudio } from "./studio";
import { useTransport } from "./transport";
import { flashBusy } from "./flash";
import type { DiskWorkspace, TaskSnapshot, TaskEnvironment } from "../../shared/desktop";
import { plugins } from "../plugins/runtime";
import type { EspPreflightResult } from "../../shared/esp";
import { decodeProject, encodeProject } from "../../shared/projectFormat";
import { mergeTaskList } from "../lib/tasks";
import { recoveryRevision, recoveryRestoredRoot, flushRecoveryDraft, noteRecoverySaved, noteRecoverySavedRevision, noteRecoveryDiscarded, recoveryOnRootOpened, startRecovery } from "./recovery";
export type DiskChangeKind = "modified" | "deleted" | "added";
export interface DiskChange { file: string; kind: DiskChangeKind; disk: string | null; local: string | null; dirty: boolean }
/** A build or upload the user requested but that stopped before creating a task (pre-build review cancelled). */
export class ActionCancelled extends Error {
  constructor(message: string) { super(message); this.name = "ActionCancelled"; }
}
export const isActionCancelled = (error: unknown) => error instanceof ActionCancelled || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ActionCancelled");
export interface BuildReviewIntent { root: string; provider: string; environment: string; options: Record<string, string> }
let pendingReview: { intent: BuildReviewIntent; resolve: (choice: "continue" | "cancel") => void } | null = null;
/** Called by the pre-build review dialog; resolving twice is a no-op. */
export function finishBuildReview(choice: "continue" | "cancel") {
  const pending = pendingReview;
  pendingReview = null;
  pending?.resolve(choice);
}
interface DiskState {
  root: string | null; changed: boolean; busy: boolean; starting: boolean; tasks: TaskSnapshot[]; error: string;
  environments: TaskEnvironment[]; environment: string;
  loadEnvironments: (provider?: string) => Promise<void>; setEnvironment: (name: string) => void; adoptTaskEnvironment: (name: string) => Promise<void>;
  directories: string[]; synced: Record<string, string>; diskFiles: Record<string, string>;
  /** Files whose disk text changed after the recovery draft was written; resolved per file. */
  recoveryConflicts: string[];
  /** Host-managed files changed after the draft was written; only save-as or reload can resolve them. */
  recoveryHostConflicts: string[];
  /** Disk text of the host-managed files at the last adopt/save, used to detect downtime changes on restore. */
  diskCircuit: string; diskManifest: string;
  /** Last ESP deploy preflight; the Deploy dialog renders its findings and next steps. */
  espPreflight: EspPreflightResult | null;
  adopt: (disk: DiskWorkspace) => void; open: () => Promise<void>; saveAs: () => Promise<void>; reload: () => Promise<void>;
  save: () => Promise<void>; detach: () => void; build: (provider: string, options?: Record<string, string>) => Promise<TaskSnapshot>; cancel: (id: string) => Promise<void>;
  /** Build, verify the plan against the device, then start the upload; a blocked plan never starts a write. */
  deploy: (provider: string, port: string, options?: Record<string, string>) => Promise<TaskSnapshot>;
  refresh: () => Promise<void>; acceptDisk: (file: string) => Promise<void>; keepLocal: (file: string) => Promise<void>; saveFile: (file: string) => Promise<void>;
}
const desktop = () => { if (!isDesktop()) throw new Error("此功能需要 Electron 桌面端"); return window.aether!; };
// The virtual circuit view mirrors components/wires; the host writes it as part of a project save.
const persisted = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([name]) => name !== "circuit.json"));
// Normalize like the host does before writing, so a draft snapshot compares byte-for-byte with the real files.
const normalized = (context: DiskWorkspace["context"]) => decodeProject(encodeProject(context));
const circuitText = (context: DiskWorkspace["context"]) => JSON.stringify({ components: context.components, wires: context.wires }, null, 2);
const manifestText = (context: DiskWorkspace["context"]) => JSON.stringify({ format: "aether-directory", version: 1, project: context.project, capabilities: context.capabilities }, null, 2);
const diskHostFiles = (context: DiskWorkspace["context"]) => ({ diskCircuit: circuitText(context), diskManifest: manifestText(context) });

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

/**
 * After a per-file resolution the buffers may match the last synced snapshot again. Recompute the unsaved flag from
 * every buffer and the host files, and retire the autosaved draft when there is nothing left to recover.
 */
export function recomputeDirty() {
  const disk = useDisk.getState();
  const state = useStudio.getState();
  const fileDirty = Object.entries(state.files).some(([name, text]) => name !== "circuit.json" && text !== (Object.hasOwn(disk.synced, name) ? disk.synced[name] : null));
  const context = state.getProjectContext();
  const hostDirty = circuitText(context) !== disk.diskCircuit || manifestText(context) !== disk.diskManifest;
  if (fileDirty || hostDirty) return false;
  useStudio.setState({ dirty: false });
  // Nothing differs from the disk, so a draft left by an earlier edit would only prompt a pointless recovery.
  if (disk.root) void noteRecoverySaved(disk.root, recoveryRevision()).catch(() => {});
  return true;
}

/**
 * Re-reads every pure external change so the original build can continue. A file that also has
 * unsaved buffer edits is a conflict: it must be resolved explicitly (use disk version or keep local)
 * before this function will proceed, and other buffers are never touched.
 */
export async function acceptReviewedDiskChanges() {
  for (const item of diskChanges()) {
    if (item.dirty) throw new Error("仍在冲突中的文件：" + item.file + "。请先选择保留磁盘版本或本地版本。");
    await useDisk.getState().acceptDisk(item.file);
  }
  const remaining = diskChanges();
  if (remaining.length) throw new Error("仍有文件差异未处理：" + remaining.map((item) => item.file).join("、") + "。请重新构建。");
}

/**
 * Opens the existing per-file disk review before a build. It resolves only when the user either
 * resolved every conflict and chose to continue, or cancelled. No task exists while it is open.
 */
function requestBuildReview(intent: BuildReviewIntent) {
  // The dialog is rendered by the project-files plugin. If it is disabled, the promise would never
  // be resolved; refuse with a clear error so the task slot is released.
  if (!plugins.all("dialogs").some((dialog) => dialog.id === "project.files.dialogs")) {
    return Promise.reject(new Error("工程文件插件未启用，无法显示构建前差异检查。请在 Plugins 中启用“工程文件”，或重新读取目录后再构建。"));
  }
  return new Promise<"continue" | "cancel">((resolve) => {
    pendingReview = { intent, resolve };
    // Loaded on demand: the dialog module imports this store, so a static import would be a cycle.
    void import("../plugins/builtin/projectFilesState").then(({ useProjectFiles }) => {
      useProjectFiles.getState().open({ kind: "changes", build: { provider: intent.provider, environment: intent.environment } });
      const dialog = useProjectFiles.getState().dialog;
      if (!dialog || dialog.kind !== "changes" || !dialog.build) {
        pendingReview = null;
        useDisk.setState({ error: "无法打开构建前差异检查：工程文件对话框未注册。" });
        resolve("cancel");
      }
    }).catch((error) => {
      pendingReview = null;
      useDisk.setState({ error: "无法打开构建前差异检查：" + String(error) });
      resolve("cancel");
    });
  });
}

export const useDisk = create<DiskState>((set, get) => {
  const recompute = () => set({ changed: diskChanges().length > 0 });
  // Responses are tied to the project and refresh that requested them; a slower answer must not win.
  let environmentRequest = 0;
  return {
  root: null, changed: false, busy: false, starting: false, tasks: [], error: "", environments: [], environment: "", directories: [], synced: {}, diskFiles: {}, recoveryConflicts: [], recoveryHostConflicts: [], diskCircuit: "", diskManifest: "", espPreflight: null,
  adopt: ({ root, context, directories }) => {
    const { project, ...workspace } = context;
    useStudio.getState().cancelAgent(); void useTransport.getState().disconnect();
    useStudio.setState({ projects: [project], activeProjectId: project.id, workspaces: { [project.id]: workspace }, ...workspace, activeTab: "circuit", activeNav: "circuit", openTabs: ["circuit", ...Object.keys(workspace.files).filter((name) => name !== "circuit.json").slice(0, 1), "serial"], dirty: false, dialog: null, selectedId: null, selectedPin: null, libraryOpen: false, runState: "idle", elapsed: 0, serial: [], console: [], agentMessages: [], proposalReview: null });
    const synced = persisted(workspace.files);
    set({ root, changed: false, error: "", environments: [], environment: "", directories: directories ?? [], synced, diskFiles: synced, recoveryConflicts: [], recoveryHostConflicts: [], ...diskHostFiles(context) }); plugins.emit("project:opened", { root, id: project.id });
  },
  open: async () => {
    if (get().starting) throw new Error("构建准备中，请先完成或取消构建前检查");
    set({ busy: true });
    const previous = get().root; const hadUnsaved = useStudio.getState().dirty;
    try {
      const result = await desktop().workspace.open();
      if (result) {
        get().adopt(result);
        // The user confirmed abandoning unsaved changes in the host's close prompt; do not resurrect them on restart.
        if (previous && hadUnsaved) await noteRecoveryDiscarded(previous).catch(() => {});
        await recoveryOnRootOpened(result.root).catch((error) => set({ error: String(error) }));
      }
    } finally { set({ busy: false }); }
  },
  saveAs: async () => {
    if (get().starting) throw new Error("构建准备中，请先完成或取消构建前检查");
    set({ busy: true });
    const previous = get().root; const restored = recoveryRestoredRoot();
    const state = useStudio.getState(); const context = state.getProjectContext(); const revision = recoveryRevision();
    try {
      const result = await desktop().workspace.saveAs(context);
      if (!result) return;
      const current = useStudio.getState();
      // Edits made while the folder was being written are newer than the saved snapshot; keep them in the buffer.
      const changed = current.files !== state.files || current.components !== state.components || current.wires !== state.wires || current.capabilities !== state.capabilities;
      const newer = changed ? { files: current.files, components: current.components, wires: current.wires, capabilities: current.capabilities, openTabs: current.openTabs, activeTab: current.activeTab, dirty: true } : null;
      get().adopt(result);
      if (newer) useStudio.setState(newer);
      // Only the revision that reached the new folder is processed; a newer draft for the old root is kept.
      const source = previous ?? restored;
      if (source) {
        if (newer) {
          // The newer buffer now belongs to the new project: persist it there first, then retire the old root's draft.
          // A failed flush must keep the old draft: those edits exist only in memory until the new draft is durable.
          const persisted = await flushRecoveryDraft().catch(() => false);
          if (persisted) await noteRecoveryDiscarded(source).catch(() => {});
          else set({ error: "恢复草稿写入失败：新工程的未保存内容尚未写入恢复草稿，原工程草稿已保留。请保存工程或稍后重试。" });
        } else await noteRecoverySavedRevision(source, revision).catch(() => {});
      }
    } finally { set({ busy: false }); }
  },
  reload: async () => { if (get().starting) throw new Error("构建准备中，请先完成或取消构建前检查"); set({ busy: true }); const previous = get().root; try { get().adopt(await desktop().workspace.reload()); if (previous) await noteRecoveryDiscarded(previous); } finally { set({ busy: false }); } },
  save: async () => {
    const state = useStudio.getState(); const context = state.getProjectContext();
    const unresolved = get().recoveryConflicts.filter((file) => Object.hasOwn(context.files, file));
    if (unresolved.length) throw new Error("磁盘内容在恢复草稿写入后已发生变化：" + unresolved.join("、") + "。请先按文件处理磁盘变更，或另存工程。");
    const hostConflicts = get().recoveryHostConflicts;
    if (hostConflicts.length) throw new Error("电路或工程元数据在恢复草稿写入后已发生变化：" + hostConflicts.join("、") + "。请另存工程到新目录，或重新读取磁盘版本；不会覆盖磁盘内容。");
    const root = get().root; const revision = recoveryRevision();
    await desktop().workspace.save(context);
    const current = useStudio.getState();
    if (current.files === state.files && current.components === state.components && current.wires === state.wires) useStudio.setState({ dirty: false });
    // Use the snapshot that was actually written; a buffer edited during the await stays dirty.
    const synced = persisted(context.files);
    set((s) => ({ changed: false, error: "", synced, diskFiles: { ...s.diskFiles, ...synced }, recoveryConflicts: [], recoveryHostConflicts: [], ...diskHostFiles(normalized(context)) }));
    plugins.emit("project:saved", { root: get().root, id: context.project.id });
    // Only the revision that was actually written is cleared; edits made during the save keep their newer draft.
    if (root) void noteRecoverySaved(root, revision).catch(() => {});
    await get().refresh();
  },
  detach: () => {
    if (!get().root) return;
    // Switching projects must never leave a build review pending: cancel it and close its dialog,
    // otherwise the new project inherits the review and the "starting" guard forever.
    finishBuildReview("cancel");
    void import("../plugins/builtin/projectFilesState").then(({ useProjectFiles }) => {
      const dialog = useProjectFiles.getState().dialog;
      if (dialog?.kind === "changes" && dialog.build) useProjectFiles.getState().close();
    }).catch(() => {});
    set({ root: null, changed: false, environments: [], environment: "", directories: [], synced: {}, diskFiles: {}, recoveryConflicts: [], recoveryHostConflicts: [], diskCircuit: "", diskManifest: "" });
    void desktop().workspace.close().catch((error) => set({ error: String(error) }));
  },
  refresh: async () => {
    if (!get().root || !isDesktop()) return;
    const listing = await desktop().workspace.files.listing();
    const files = useStudio.getState().files;
    const synced = { ...get().synced };
    // A file that already matches the buffer needs no manual decision.
    const matched: string[] = [];
    for (const [name, text] of Object.entries(listing.files)) if (Object.hasOwn(files, name) && files[name] === text) {
      if (synced[name] !== text) matched.push(name);
      synced[name] = text;
    }
    set({ directories: listing.directories, diskFiles: listing.files, synced, error: "" });
    recompute();
    // Advance the host baseline for the same files: the buffer already equals the disk, and without
    // this a whole-project save would still refuse the external write as an unaccepted change. The
    // expected text is a precondition: if the file changed again after the listing, the baseline is
    // not advanced and the next refresh reports the conflict instead of overwriting it silently.
    for (const name of matched) await desktop().workspace.files.accept(name, listing.files[name]).catch(() => {});
  },
  acceptDisk: async (file) => {
    const change = diskChanges().find((item) => item.file === file);
    if (!change) return;
    // The host baseline must accept the disk content too, otherwise the next whole-project save would refuse.
    await desktop().workspace.files.accept(file, change.disk);
    if (change.kind === "deleted") {
      useStudio.getState().removePaths([file]);
      set((s) => { const synced = { ...s.synced }; delete synced[file]; const diskFiles = { ...s.diskFiles }; delete diskFiles[file]; return { synced, diskFiles, recoveryConflicts: s.recoveryConflicts.filter((name) => name !== file) }; });
    } else {
      const text = change.disk ?? "";
      useStudio.setState((s) => ({ files: { ...s.files, [file]: text } }));
      set((s) => ({ synced: { ...s.synced, [file]: text }, diskFiles: { ...s.diskFiles, [file]: text }, recoveryConflicts: s.recoveryConflicts.filter((name) => name !== file) }));
      if (change.kind === "added") useStudio.getState().openFile(file);
    }
    recompute();
    recomputeDirty();
  },
  keepLocal: async (file) => {
    const change = diskChanges().find((item) => item.file === file);
    if (!change) return;
    const local = useStudio.getState().files[file];
    if (local === undefined) throw new Error("本地缓冲区没有此文件，无法覆盖磁盘：" + file);
    // The previewed disk text is the precondition: a second external change is refused instead of overwritten.
    await desktop().workspace.files.write(file, local, change.disk);
    const wasDirty = local !== (Object.hasOwn(get().synced, file) ? get().synced[file] : "");
    set((s) => ({ synced: { ...s.synced, [file]: local }, diskFiles: { ...s.diskFiles, [file]: local }, recoveryConflicts: s.recoveryConflicts.filter((name) => name !== file), error: "" }));
    if (wasDirty) useStudio.setState({ dirty: true });
    recompute();
    recomputeDirty();
  },
  saveFile: async (file) => {
    const text = useStudio.getState().files[file];
    if (text === undefined) throw new Error("本地缓冲区没有此文件：" + file);
    const expected = Object.hasOwn(get().diskFiles, file) ? get().diskFiles[file] : null;
    await desktop().workspace.files.write(file, text, expected);
    set((s) => ({ synced: { ...s.synced, [file]: text }, diskFiles: { ...s.diskFiles, [file]: text }, recoveryConflicts: s.recoveryConflicts.filter((name) => name !== file), error: "" }));
    recompute();
    recomputeDirty();
  },
  loadEnvironments: async (provider = "platformio.build") => {
    const root = get().root;
    if (!root || !isDesktop()) return;
    const request = ++environmentRequest;
    const environments = await desktop().tasks.environments(provider);
    if (request !== environmentRequest || get().root !== root) return;
    // While a task runs or a build is being reviewed its environment is fixed; refreshing may update the list but never the selection.
    if (get().tasks.some((task) => task.status === "running") || get().starting) { set({ environments }); return; }
    const current = get().environment;
    const environment = environments.some((item) => item.name === current) ? current : (environments.find((item) => item.default) ?? environments[0])?.name ?? "";
    set({ environments, environment });
  },
  setEnvironment: (name) => {
    const state = get();
    if (state.starting) throw new Error("构建准备中，请先完成或取消构建前检查");
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
    const root = get().root;
    if (!root) throw new Error("请先使用 Save project to folder 保存到磁盘，或打开工程目录");
    if (flashBusy()) throw new Error("Flash 备份/恢复正在进行，请完成或取消后再构建/上传");
    if (get().starting) throw new Error("上一个构建请求仍在准备中，请稍候");
    if (get().tasks.some((task) => task.status === "running")) throw new Error("已有任务运行，请等待或取消");
    // The project, environment and options are captured now; the review cannot swap them later.
    const environment = get().environment;
    const requested = { ...(options ?? {}) };
    // Reserve the port for the whole review/save/start window so the monitor cannot reopen it before the task is registered.
    set({ starting: true, error: "" });
    try {
      // Read the current disk text first; external edits are the reason a build used to stop with an error.
      await get().refresh();
      if (diskChanges().length) {
        const choice = await requestBuildReview({ root, provider, environment, options: requested });
        if (choice !== "continue") throw new ActionCancelled("已取消：未创建构建任务，也未触发烧录。");
        if (get().root !== root) throw new ActionCancelled("工程目录在确认后发生变化，已取消；未创建任务。");
        if ((provider.startsWith("platformio.") || provider.startsWith("esp.")) && get().environment !== environment) throw new ActionCancelled("构建环境在确认后发生变化，已取消；未创建任务。");
        const remaining = diskChanges();
        if (remaining.length) throw new Error("构建前检查后磁盘再次变化：" + remaining.map((item) => item.file).join("、") + "。请重新构建。");
      }
      await get().save();
      await useTransport.getState().disconnect();
      // Do not start an upload while a serial session still owns the port; PlatformIO would fail with a misleading error.
      if (useTransport.getState().status !== "disconnected") throw new Error("串口监视器尚未释放端口，已取消任务。请手动断开连接后重试。");
      // PlatformIO 的构建、上传和编译数据库共用当前选定的环境，避免产物和数据库串用。
      const task = await desktop().tasks.start(provider, (provider.startsWith("platformio.") || provider.startsWith("esp.")) && environment ? { ...requested, environment } : requested);
      set((s) => ({ error: "", tasks: mergeTaskList(s.tasks, task) }));
      return task;
    } finally { set({ starting: false }); }
  },
  cancel: async (id) => { await desktop().tasks.cancel(id); },
  deploy: async (provider, port, options = {}) => {
    if (!get().root) throw new Error("请先使用 Save project to folder 保存到磁盘，或打开工程目录");
    if (!port.trim()) throw new Error("请明确选择烧录端口");
    const environment = get().environment;
    // 1. Build first: the preflight inspects this exact build, never a stale build directory.
    const started = await get().build("platformio.build", { environment });
    const built = await waitForTask(started.id);
    if (built.status !== "succeeded") throw new Error("构建未通过（" + built.status + "）：" + (built.error || "见 Build Tasks 日志"));
    // 2. Ask every registered device plugin which provider must perform the write. The preview below
    //    only drives the UI; the provider re-derives and re-verifies everything before it writes.
    let target = provider;
    let checked = false;
    for (const device of plugins.all("devices")) {
      const result = await device.preflight({ environment, port: port.trim() });
      set({ espPreflight: result });
      if (!result.supported) continue;
      checked = true;
      target = device.uploadProvider;
      if (!result.ok) throw new Error("部署前核对未通过：" + result.findings.filter((finding) => finding.severity === "block").map((finding) => finding.title).join("；"));
      break;
    }
    if (!checked) set({ espPreflight: null });
    // 3. Upload through the provider that owns the verified write path.
    return get().build(target, { ...options, port: port.trim() });
  },
  };
});
/** Resolves when a task started by this session stops running; polls the host list so a restart is visible. */
export async function waitForTask(id: string, timeoutMs = 30 * 60 * 1000): Promise<TaskSnapshot> {
  const api = desktop();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = useDisk.getState().tasks.find((item) => item.id === id) ?? (await api.tasks.list().catch(() => [])).find((item) => item.id === id);
    if (task && task.status !== "running") return task;
    if (Date.now() > deadline) throw new Error("等待任务结束超时：" + id);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
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
  void api.workspace.restore().then((result) => { if (current && result) useDisk.getState().adopt(result); }).catch((error) => { if (current) useDisk.setState({ error: "重新打开工程失败：" + String(error) }); }).finally(() => {
    // Drafts are listed after the remembered project is adopted so a restore never races the open.
    if (current) void startRecovery().catch((error) => useDisk.setState({ error: "恢复草稿初始化失败：" + String(error) }));
  });
  void api.tasks.list().then((tasks) => { if (current) useDisk.setState((s) => ({ tasks: [...tasks.filter((task) => !s.tasks.some((old) => old.id === task.id)), ...s.tasks] })); });
  return () => { current = false; offDirty(); offWorkspace(); offTasks(); };
}
