import { create } from "zustand";
import type { RecoveryDraft, RecoverySummary } from "../../shared/desktop";
import { isDesktop } from "../lib/desktop";

interface RecoveryState {
  drafts: RecoverySummary[];
  preview: RecoveryDraft | null;
  error: string;
  loading: boolean;
  restoring: boolean;
  refresh: () => Promise<void>;
  previewDraft: (root: string) => Promise<void>;
  restore: () => Promise<void>;
  discard: (root?: string) => Promise<void>;
  later: () => void;
  openDialog: () => void;
}

const api = () => { if (!isDesktop()) throw new Error("恢复草稿仅支持 Electron 桌面端"); return window.aether!.recovery; };
const openRecoveryDialog = async () => {
  try {
    const { useProjectFiles } = await import("../plugins/builtin/projectFilesState");
    useProjectFiles.getState().open({ kind: "recovery" });
  } catch (error) { useRecovery.setState({ error: "无法打开恢复草稿窗口：" + (error instanceof Error ? error.message : String(error)) }); }
};
const closeRecoveryDialog = async () => {
  const { useProjectFiles } = await import("../plugins/builtin/projectFilesState");
  if (useProjectFiles.getState().dialog?.kind === "recovery") useProjectFiles.getState().close();
};

export const useRecovery = create<RecoveryState>((set, get) => ({
  drafts: [], preview: null, error: "", loading: false, restoring: false,
  refresh: async () => {
    if (!isDesktop()) return;
    set({ loading: true });
    // Damaged drafts stay listed with their own error; one bad file must not hide the others.
    const drafts = await api().list();
    set({ drafts, loading: false, error: "" });
  },
  previewDraft: async (root) => {
    set({ preview: null, error: "", restoring: false });
    try { set({ preview: await api().read(root) }); }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
  },
  restore: async () => {
    const draft = get().preview;
    if (!draft) return;
    set({ restoring: true, error: "" });
    try {
      const [{ useDisk }, { useStudio }] = await Promise.all([import("./disk"), import("./studio")]);
      const current = useDisk.getState().root;
      if (current && current !== draft.root) throw new Error("当前打开的工程目录与恢复草稿不一致。请先打开 " + draft.root + " 再恢复此草稿。");
      const summary = get().drafts.find((item) => item.root === draft.root);
      if (!current && summary?.rootExists) throw new Error("请先打开该工程目录，再恢复此草稿： " + draft.root);
      const workspace = { components: draft.context.components, wires: draft.context.wires, files: draft.context.files, capabilities: draft.context.capabilities };
      const tabs = draft.openTabs.filter((tab) => tab === "circuit" || tab === "serial" || Object.hasOwn(workspace.files, tab));
      const openTabs = tabs.length ? tabs : ["circuit", "serial"];
      const activeTab = openTabs.includes(draft.activeTab) ? draft.activeTab : openTabs[0];
      useStudio.setState({
        projects: [draft.context.project], activeProjectId: draft.context.project.id,
        workspaces: { [draft.context.project.id]: workspace },
        ...workspace, openTabs, activeTab, dirty: true,
        dialog: null, selectedId: null, selectedPin: null, wireStart: null, proposalReview: null,
      });
      if (current) {
        // The draft remembers the disk text it was based on. If the disk changed while the app was down,
        // keep that older baseline so the existing per-file review and whole-project save guard stay in force.
        const diskNow = useDisk.getState().diskFiles;
        const synced = { ...useDisk.getState().synced };
        const conflicts: string[] = [];
        for (const [name, text] of Object.entries(draft.disk ?? {})) {
          if (name === "circuit.json" || Object.hasOwn(diskNow, name) && diskNow[name] === text) continue;
          synced[name] = text; conflicts.push(name);
        }
        useDisk.setState({ synced, recoveryConflicts: conflicts, changed: conflicts.length > 0 });
      }
      // Remember the draft's own root: the project directory may be gone and the user may save to a new folder.
      inMemoryRestoredRoot = draft.root;
      // The restored content becomes a new revision; the old draft stays until a save or discard processes it.
      contentRevision = Math.max(Date.now(), contentRevision + 1, draft.revision + 1);
      lastContent = ""; lastTabs = "";
      schedule(0);
      set({ preview: null, restoring: false });
      await closeRecoveryDialog();
      useStudio.getState().addToast({ title: "已恢复未保存内容", detail: "内容已进入缓冲区，尚未写入磁盘；保存前仍会检查磁盘外部修改。", tone: "success" });
    } catch (error) {
      set({ restoring: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  discard: async (root) => {
    const target = root ?? get().preview?.root;
    if (!target) return;
    set({ error: "" });
    try {
      const summary = get().drafts.find((item) => item.root === target);
      // A damaged draft cannot be compared by revision; explicit discard removes only that draft's directory.
      const preview = get().preview?.root === target ? get().preview : null;
      const cleared = summary?.error ? await api().discard(target) : await api().clear(target, preview ? preview.revision : summary?.revision ?? 0);
      if (!cleared) set({ error: "恢复草稿在预览后被更新，未丢弃；请重新查看后再决定。" });
      else if (inMemoryRestoredRoot === target) inMemoryRestoredRoot = null;
      await get().refresh();
      if (get().preview?.root === target) set({ preview: null });
      if (!get().drafts.length) await closeRecoveryDialog();
    } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
  },
  later: () => { set({ preview: null }); void closeRecoveryDialog(); },
  openDialog: () => { void openRecoveryDialog(); },
}));

// Autosave writes only dirty buffers to the user data directory; it never saves the project or touches disk files.
let contentRevision = Date.now();
let lastContent = "";
let lastTabs = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
// A save or discard must not leave a draft behind when an autosave was already in flight.
let clearedRevision = 0;
let inMemoryRestoredRoot: string | null = null;

async function writeDraft() {
  const [{ useDisk }, { useStudio }] = await Promise.all([import("./disk"), import("./studio")]);
  const root = useDisk.getState().root;
  const state = useStudio.getState();
  if (!root || !isDesktop() || !state.dirty) return;
  const revision = contentRevision;
  if (revision <= clearedRevision) return;
  const synced = useDisk.getState().synced;
  const draft: RecoveryDraft = {
    version: 1, root, revision, updatedAt: new Date().toISOString(), context: state.getProjectContext(),
    disk: Object.fromEntries(Object.entries(synced).filter(([name]) => name !== "circuit.json")),
    openTabs: state.openTabs.filter((tab) => tab === "circuit" || tab === "serial" || Object.hasOwn(state.files, tab)),
    activeTab: state.activeTab,
  };
  try {
    await api().save(draft); useRecovery.setState({ error: "" });
    // The save cleared the draft while this write was in flight; remove only that exact revision again.
    if (revision <= clearedRevision) await api().clear(root, revision);
  } catch (error) { useRecovery.setState({ error: "恢复草稿写入失败：" + (error instanceof Error ? error.message : String(error)) }); }
}

function schedule(delay = 700) {
  clearTimeout(timer);
  timer = setTimeout(() => { void writeDraft(); }, delay);
}

/** Monotonic revision of the buffer content, used to clear only the version that was actually saved. */
export const recoveryRevision = () => contentRevision;

export async function refreshRecoveryDrafts() {
  if (!isDesktop()) return;
  try {
    const drafts = await api().list();
    useRecovery.setState({ drafts });
    contentRevision = Math.max(contentRevision, ...drafts.map((draft) => draft.revision + 1));
  } catch (error) { useRecovery.setState({ error: "读取恢复草稿失败：" + (error instanceof Error ? error.message : String(error)) }); }
}

/** After a successful whole-project save, clear the draft only when no newer edit happened during the save. */
export async function noteRecoverySaved(root: string, revision: number) {
  if (!isDesktop()) return;
  if (contentRevision !== revision) return;
  clearedRevision = Math.max(clearedRevision, revision);
  clearTimeout(timer);
  try { await api().clear(root, revision); }
  catch (error) { useRecovery.setState({ error: "清理恢复草稿失败：" + (error instanceof Error ? error.message : String(error)) }); }
  if (inMemoryRestoredRoot === root) inMemoryRestoredRoot = null;
  await refreshRecoveryDrafts();
}

/** Reload/explicit discard: the user confirmed dropping these buffers, so the root's draft is stale. */
export async function noteRecoveryDiscarded(root: string) {
  if (!isDesktop()) return;
  clearedRevision = Math.max(clearedRevision, contentRevision);
  clearTimeout(timer);
  try { await api().discard(root); } finally { if (inMemoryRestoredRoot === root) inMemoryRestoredRoot = null; await refreshRecoveryDrafts(); }
}

/** Root of a draft restored while its project directory was unavailable, for save-as cleanup. */
export const recoveryRestoredRoot = () => inMemoryRestoredRoot;

export async function recoveryOnRootOpened(root: string) {
  if (!isDesktop()) return;
  await refreshRecoveryDrafts();
  if (useRecovery.getState().drafts.some((draft) => draft.root === root)) await openRecoveryDialog();
}

export async function startRecovery() {
  if (!isDesktop() || started) return;
  started = true;
  const [{ useStudio }, { useDisk }] = await Promise.all([import("./studio"), import("./disk")]);
  await refreshRecoveryDrafts();
  const observe = () => {
    const state = useStudio.getState();
    const root = useDisk.getState().root;
    const content = JSON.stringify({ root, files: state.files, components: state.components, wires: state.wires, capabilities: state.capabilities, projectId: state.activeProjectId });
    const contentChanged = content !== lastContent;
    if (contentChanged) {
      lastContent = content;
      contentRevision = Math.max(Date.now(), contentRevision + 1);
    }
    const tabs = JSON.stringify({ openTabs: state.openTabs, activeTab: state.activeTab });
    // Tab switches do not create new content, but they are part of the draft and still schedule a write.
    if (!contentChanged && tabs === lastTabs) return;
    lastTabs = tabs;
    if (root && state.dirty) schedule();
  };
  useStudio.subscribe(observe);
  useDisk.subscribe(observe);
  lastContent = ""; lastTabs = "";
  if (useRecovery.getState().drafts.length) await openRecoveryDialog();
}
