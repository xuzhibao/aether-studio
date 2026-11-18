import { create } from "zustand";
import { isDesktop } from "../../lib/desktop";
import { recomputeDirty, useDisk, finishBuildReview } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { validProjectPath } from "../../../shared/projectFormat";

export type ProjectFilesDialog =
  | { kind: "create"; mode: "file" | "directory"; parent: string }
  | { kind: "rename"; target: string; directory: boolean }
  | { kind: "delete"; target: string; directory: boolean }
  | { kind: "changes"; file?: string; build?: { provider: string; environment: string } }
  | { kind: "recovery"; root?: string }
  | null;

interface ProjectFilesState {
  dialog: ProjectFilesDialog;
  selected: string | null;
  open: (dialog: ProjectFilesDialog) => void;
  close: () => void;
  select: (path: string | null) => void;
}

export const useProjectFiles = create<ProjectFilesState>((set, get) => ({
  dialog: null,
  selected: null,
  open: (dialog) => {
    // Replacing a build-review dialog without choosing means the requested build must not start.
    const current = get().dialog;
    const keepsReview = dialog?.kind === "changes" && !!dialog.build;
    if (current?.kind === "changes" && current.build && !keepsReview) finishBuildReview("cancel");
    set({ dialog });
  },
  close: () => set({ dialog: null }),
  select: (path) => set({ selected: path }),
}));

export const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (parent: string, name: string) => parent ? parent + "/" + name : name;

/** The host rejects reserved, ignored and escaping paths itself; this only gives instant feedback. */
export function pathProblem(path: string, taken: string[] = []) {
  if (!path) return "";
  if (!validProjectPath(path)) return "请输入工程内的相对路径（不能包含 ..、盘符或以 / 开头）。";
  if (path.split("/").some((part) => [".git", ".pio", ".aether", "node_modules", "dist", "build", "target", "release", "desktop-dist", ".cache"].includes(part))) return "不能操作工具缓存目录。";
  if (["aether.project.json", "circuit.json", "hardware", "hardware/circuit.json"].includes(path)) return "此路径由宿主管理。";
  if (taken.includes(path)) return "同名文件或目录已存在。";
  return "";
}

export function requireDisk() {
  if (!isDesktop()) throw new Error("磁盘文件操作仅支持 Electron 桌面端；浏览器中不会伪装成功。");
  if (!useDisk.getState().root) throw new Error("请先打开或保存磁盘工程目录。");
  return window.aether!;
}

/** Buffers whose content differs from the last synced disk text, at or below path. */
export function dirtyUnder(path: string) {
  const { synced } = useDisk.getState();
  const files = useStudio.getState().files;
  return Object.keys(files).filter((name) => {
    if (name === "circuit.json") return false;
    if (!(name === path || name.startsWith(path + "/"))) return false;
    return files[name] !== (Object.hasOwn(synced, name) ? synced[name] : null);
  }).sort();
}

async function settle() {
  await useDisk.getState().refresh();
}

export async function createEntry(mode: "file" | "directory", path: string) {
  const api = requireDisk();
  if (mode === "file") {
    await api.workspace.files.createFile(path);
    await useDisk.getState().refresh();
    const text = useDisk.getState().diskFiles[path] ?? "";
    useStudio.setState((state) => ({ files: { ...state.files, [path]: text } }));
    useDisk.setState((state) => ({ synced: { ...state.synced, [path]: text } }));
    useStudio.getState().openFile(path);
  } else {
    await api.workspace.files.createDirectory(path);
    await useDisk.getState().refresh();
  }
}

export async function deleteEntry(path: string, directory: boolean) {
  const api = requireDisk();
  const { diskFiles, directories } = useDisk.getState();
  const onDisk = directory ? directories.includes(path) : Object.hasOwn(diskFiles, path);
  if (!directory && !onDisk) {
    // Only the unsaved buffer exists: removing it is honest, and nothing is trashed.
    useStudio.getState().removePaths([path]);
    useDisk.setState((state) => {
      const synced = { ...state.synced }; delete synced[path];
      const diskFilesNext = { ...state.diskFiles }; delete diskFilesNext[path];
      return { synced, diskFiles: diskFilesNext };
    });
    recomputeDirty();
    return;
  }
  await api.workspace.files.trash(path);
  useStudio.getState().removePaths([path]);
  useDisk.setState((state) => {
    const synced = Object.fromEntries(Object.entries(state.synced).filter(([name]) => name !== path && !name.startsWith(path + "/")));
    const diskFilesNext = Object.fromEntries(Object.entries(state.diskFiles).filter(([name]) => name !== path && !name.startsWith(path + "/")));
    const directories = state.directories.filter((name) => name !== path && !name.startsWith(path + "/"));
    return { synced, diskFiles: diskFilesNext, directories };
  });
  await useDisk.getState().refresh();
  recomputeDirty();
}

export async function renameEntry(from: string, to: string, choice: "save" | "discard") {
  const api = requireDisk();
  const dirty = dirtyUnder(from);
  const { diskFiles, directories } = useDisk.getState();
  const onDisk = Object.hasOwn(diskFiles, from) || directories.includes(from) || Object.keys(diskFiles).some((name) => name.startsWith(from + "/"));
  // Discarding is only meaningful when the path exists on disk; a buffer-only path must be saved first.
  if (!onDisk && choice === "discard") throw new Error("磁盘上不存在此路径，无法放弃修改后重命名；请选择先保存再重命名。");
  if (choice === "save") {
    for (const file of dirty) await useDisk.getState().saveFile(file);
  } else {
    for (const file of dirty) {
      const disk = Object.hasOwn(useDisk.getState().diskFiles, file) ? useDisk.getState().diskFiles[file] : null;
      if (disk === null) useStudio.getState().removePaths([file]);
      else useStudio.setState((state) => ({ files: { ...state.files, [file]: disk } }));
    }
  }
  await api.workspace.files.rename(from, to);
  useStudio.getState().renamePath(from, to);
  useDisk.setState((state) => {
    const rename = (name: string) => name === from ? to : name.startsWith(from + "/") ? to + name.slice(from.length) : name;
    return {
      synced: Object.fromEntries(Object.entries(state.synced).map(([name, text]) => [rename(name), text])),
      diskFiles: Object.fromEntries(Object.entries(state.diskFiles).map(([name, text]) => [rename(name), text])),
      directories: state.directories.map(rename),
    };
  });
  await settle();
  recomputeDirty();
}

export async function openChanges() {
  useProjectFiles.getState().open({ kind: "changes" });
  await useDisk.getState().refresh().catch(() => {});
}
