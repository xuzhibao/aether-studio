import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DiffEditor, useMonaco } from "@monaco-editor/react";
import { AlertTriangle, FilePlus2, FolderPlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { CloseButton, Modal } from "../../components/Dialogs";
import { useDisk, diskChanges } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { cn } from "../../lib/utils";
import {
  createEntry, deleteEntry, dirtyUnder, joinPath, pathProblem, renameEntry, useProjectFiles,
} from "./projectFilesState";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const languageFor = (file: string) => {
  if (/\.(cpp|hpp|cc|cxx|h|hh|hxx|c)$/.test(file)) return file.endsWith(".c") ? "c" : "cpp";
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".md")) return "markdown";
  if (file.endsWith(".ini")) return "ini";
  return "plaintext";
};

export function ProjectFilesDialogs() {
  const dialog = useProjectFiles((state) => state.dialog);
  if (!dialog) return null;
  if (dialog.kind === "create") return <CreateEntryDialog key={dialog.mode + ":" + dialog.parent} mode={dialog.mode} parent={dialog.parent} />;
  if (dialog.kind === "rename") return <RenameEntryDialog key={dialog.target} target={dialog.target} effectiveDirectory={dialog.directory} />;
  if (dialog.kind === "delete") return <DeleteEntryDialog key={dialog.target} target={dialog.target} directory={dialog.directory} />;
  return <DiskChangesDialog />;
}

function CreateEntryDialog({ mode, parent }: { mode: "file" | "directory"; parent: string }) {
  const close = useProjectFiles((state) => state.close);
  const files = useStudio((state) => state.files);
  const directories = useDisk((state) => state.directories);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const path = joinPath(parent, name.trim());
  const problem = name.trim() ? pathProblem(path, [...Object.keys(files), ...directories]) : "";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || problem || busy) return;
    setBusy(true); setError("");
    try {
      await createEntry(mode, path);
      useStudio.getState().addToast({ title: mode === "file" ? "文件已创建" : "目录已创建", detail: "真实写入工程目录：" + path, tone: "success" });
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <Modal open onOpenChange={(open) => !open && close()} width={440}>
      <form onSubmit={submit}>
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-[#EEF4FB] text-[#3F6FA5]">
            {mode === "file" ? <FilePlus2 size={15} strokeWidth={1.7} /> : <FolderPlus size={15} strokeWidth={1.7} />}
          </div>
          <div className="min-w-0 flex-1">
            <Dialog.Title className="text-[13px] font-semibold text-[#23272C]">{mode === "file" ? "New file" : "New folder"}</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-[10px] text-[#90969E]">在磁盘工程中创建{mode === "file" ? "文件" : "目录"}，立即落盘。</Dialog.Description>
          </div>
          <CloseButton onClick={close} />
        </div>
        <div className="border-t border-[#ECEEF1] px-5 py-4">
          <label className="label-caps mb-1.5 block text-[8.5px]">Path</label>
          <input
            autoFocus
            aria-label={mode === "file" ? "New file path" : "New folder path"}
            className="input h-[32px] w-full text-[11.5px]"
            value={name}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            placeholder={parent ? parent + "/" + (mode === "file" ? "sensor.cpp" : "drivers") : mode === "file" ? "src/sensor.cpp" : "drivers"}
          />
          <p className="mt-2 text-[9px] text-[#9AA0A8]">将创建：<span className="font-mono">{path || "—"}</span></p>
          {problem && <p role="alert" className="mt-2 text-[10px] text-[#A8741F]">{problem}</p>}
          {error && <p role="alert" className="mt-2 text-[10px] text-[#A8741F]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
          <button type="button" className="btn h-[27px] px-2.5 text-[10px]" onClick={close}>Cancel</button>
          <button type="submit" disabled={!name.trim() || !!problem || busy} className="btn btn-primary h-[27px] px-3 text-[10px]">Create</button>
        </div>
      </form>
    </Modal>
  );
}

function RenameEntryDialog({ target, effectiveDirectory }: { target: string; effectiveDirectory: boolean }) {
  const close = useProjectFiles((state) => state.close);
  const files = useStudio((state) => state.files);
  const directories = useDisk((state) => state.directories);
  const [value, setValue] = useState(target);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = dirtyUnder(target);
  const problem = value.trim() === target ? "" : pathProblem(value.trim(), [...Object.keys(files), ...directories].filter((item) => item !== target));
  const run = async (choice: "save" | "discard") => {
    if (!value.trim() || problem || busy) return;
    setBusy(true); setError("");
    try {
      await renameEntry(target, value.trim(), choice);
      useStudio.getState().addToast({ title: "已重命名", detail: target + " → " + value.trim(), tone: "success" });
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <Modal open onOpenChange={(open) => !open && close()} width={480}>
      <form onSubmit={(event) => { event.preventDefault(); void run("save"); }}>
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-[#EEF4FB] text-[#3F6FA5]"><Pencil size={14} strokeWidth={1.7} /></div>
          <div className="min-w-0 flex-1">
            <Dialog.Title className="text-[13px] font-semibold text-[#23272C]">Rename {effectiveDirectory ? "folder" : "file"}</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-[10px] text-[#90969E]">重命名会立即修改磁盘路径；打开标签页和缓冲区会跟随新路径。</Dialog.Description>
          </div>
          <CloseButton onClick={close} />
        </div>
        <div className="border-t border-[#ECEEF1] px-5 py-4">
          <label className="label-caps mb-1.5 block text-[8.5px]">Current path</label>
          <p className="mb-3 break-all font-mono text-[10.5px] text-[#5D626A]">{target}</p>
          <label className="label-caps mb-1.5 block text-[8.5px]">New path</label>
          <input autoFocus aria-label="New path" className="input h-[32px] w-full text-[11.5px]" value={value} onChange={(event) => { setValue(event.target.value); setError(""); }} />
          {problem && <p role="alert" className="mt-2 text-[10px] text-[#A8741F]">{problem}</p>}
          {error && <p role="alert" className="mt-2 text-[10px] text-[#A8741F]">{error}</p>}
          {dirty.length > 0 && (
            <div className="mt-3 rounded-[6px] border border-[#EFE1C2] bg-[#FFF9EC] px-2.5 py-2">
              <p className="flex items-center gap-1.5 text-[10px] font-medium text-[#966A22]"><AlertTriangle size={11} /> 以下文件有未保存修改</p>
              <p className="mt-1 break-all font-mono text-[9.5px] text-[#8A733F]">{dirty.join("\n")}</p>
              <p className="mt-1 text-[9px] text-[#9C8A5E]">请选择先保存再重命名，或明确放弃这些缓冲区修改。</p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
          <button type="button" className="btn h-[27px] px-2.5 text-[10px]" onClick={close}>Cancel</button>
          {dirty.length > 0 ? (
            <>
              <button type="button" disabled={busy || !!problem} className="btn h-[27px] px-2.5 text-[10px]" onClick={() => void run("discard")}>Discard changes and rename</button>
              <button type="submit" disabled={busy || !!problem} className="btn btn-primary h-[27px] px-3 text-[10px]">Save and rename</button>
            </>
          ) : (
            <button type="submit" disabled={busy || !!problem || value.trim() === target} className="btn btn-primary h-[27px] px-3 text-[10px]">Rename</button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function DeleteEntryDialog({ target, directory }: { target: string; directory: boolean }) {
  const close = useProjectFiles((state) => state.close);
  const root = useDisk((state) => state.root);
  const diskFiles = useDisk((state) => state.diskFiles);
  const directories = useDisk((state) => state.directories);
  const files = useStudio((state) => state.files);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = dirtyUnder(target);
  const onDisk = directory ? directories.includes(target) : Object.hasOwn(diskFiles, target);
  const bufferOnly = !directory && !onDisk && Object.hasOwn(files, target);
  const absolute = root ? root.replaceAll("\\", "/") + "/" + target : target;
  const run = async () => {
    setBusy(true); setError("");
    try {
      await deleteEntry(target, directory);
      useStudio.getState().addToast({ title: bufferOnly ? "已丢弃缓冲区文件" : "已移入系统回收站", detail: target, tone: "success" });
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <Modal open onOpenChange={(open) => !open && close()} width={520}>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-[#FDEEEC] text-[#C0503F]"><Trash2 size={15} strokeWidth={1.7} /></div>
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-[13px] font-semibold text-[#23272C]">Move to Trash</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[10px] text-[#90969E]">
            {bufferOnly ? "该文件仅存在于编辑缓冲区，磁盘上没有文件；不会调用回收站。" : "删除会调用系统回收站，可从回收站恢复；不会使用永久删除。"}
          </Dialog.Description>
        </div>
        <CloseButton onClick={close} />
      </div>
      <div className="border-t border-[#ECEEF1] px-5 py-4">
        <p className="label-caps mb-1 block text-[8.5px]">{directory ? "Folder" : "File"}</p>
        <p className="break-all font-mono text-[11px] text-[#3A3E44]">{target}</p>
        <p className="mt-1 break-all font-mono text-[9.5px] text-[#9AA0A8]">{absolute}</p>
        {dirty.length > 0 && (
          <div className="mt-3 rounded-[6px] border border-[#EFE1C2] bg-[#FFF9EC] px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-[10px] font-medium text-[#966A22]"><AlertTriangle size={11} /> 有未保存修改，删除会放弃这些缓冲区</p>
            <p className="mt-1 break-all font-mono text-[9.5px] text-[#8A733F]">{dirty.join("\n")}</p>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-[10px] text-[#A8741F]">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <button className="btn h-[27px] px-2.5 text-[10px]" onClick={close}>Cancel</button>
        <button disabled={busy} className="btn h-[27px] px-3 text-[10px] text-[#B0402F]" onClick={() => void run()}>
          {dirty.length > 0 ? "Discard changes and move to Trash" : bufferOnly ? "Discard buffer" : "Move to Trash"}
        </button>
      </div>
    </Modal>
  );
}

const changeLabel = { modified: "磁盘已修改", deleted: "磁盘已删除", added: "磁盘新增" } as const;
let diffSession = 0;

function DiskChangesDialog() {
  const close = useProjectFiles((state) => state.close);
  const initial = useProjectFiles((state) => state.dialog);
  const disk = useDisk();
  const root = useDisk((state) => state.root) ?? "";
  const monaco = useMonaco();
  const [session] = useState(() => ++diffSession);
  const modelPaths = useRef(new Set<string>());
  const touch = (kind: "disk" | "buffer", file: string) => `inmemory://aether/${encodeURIComponent(root)}/${session}/${kind}/${encodeURIComponent(file)}`;
  const changes = diskChanges();
  const [selected, setSelected] = useState<string | null>(initial && initial.kind === "changes" ? initial.file ?? null : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const change = changes.find((item) => item.file === selected) ?? changes[0];
  useEffect(() => { if (!change && changes.length) setSelected(changes[0].file); }, [changes.length]);
  useEffect(() => { void disk.refresh().catch((failure) => setError(errorText(failure))); }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  const local = change?.local ?? null;
  const diskPath = change ? touch("disk", change.file) : "";
  const localPath = change ? touch("buffer", change.file) : "";
  if (change) { modelPaths.current.add(diskPath); modelPaths.current.add(localPath); }
  useEffect(() => {
    return () => {
      const paths = [...modelPaths.current];
      if (!monaco || !paths.length) return;
      // The DiffEditor disposes its widget in a child cleanup; release the kept models after that.
      setTimeout(() => { for (const path of paths) monaco.editor.getModel(monaco.Uri.parse(path))?.dispose(); }, 0);
    };
  }, [monaco]);
  return (
    <Modal open onOpenChange={(open) => !open && close()} width={1040}>
      <div className="flex items-start justify-between p-5">
        <div>
          <Dialog.Title className="text-sm font-semibold">磁盘与缓冲区差异</Dialog.Title>
          <Dialog.Description className="mt-2 text-xs text-[#7D848C]">逐文件比较磁盘版本与本地缓冲区。处理一个文件不会丢弃其他文件的未保存修改；未处理的冲突仍会阻止整工程保存。</Dialog.Description>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn h-[24px] px-2 text-[10px]" onClick={() => void disk.refresh().catch((failure) => setError(errorText(failure)))}><RefreshCw size={11} /> 重新检查</button>
          <CloseButton onClick={close} />
        </div>
      </div>
      {changes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 border-t border-[#ECEEF1] px-5 py-14 text-center">
          <p className="text-[12px] text-[#4C525A]">磁盘与本地缓冲区一致。</p>
          <p className="text-[10px] text-[#9AA0A8]">外部修改、新增或删除会在这里按文件列出。</p>
        </div>
      ) : (
        <div className="grid min-h-[360px] grid-cols-[248px_minmax(0,1fr)] border-t border-[#ECEEF1]">
          <div className="max-h-[52vh] overflow-y-auto border-r border-[#ECEEF1] p-2">
            {changes.map((item) => (
              <button key={item.file} className={cn("w-full rounded-[5px] px-2 py-1.5 text-left", change?.file === item.file ? "bg-[#EAF3FF]" : "hover:bg-[#F3F5F8]")} onClick={() => setSelected(item.file)}>
                <span className="block truncate font-mono text-[10px] text-[#3A3E44]">{item.file}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[8.5px] text-[#9AA0A8]">
                  {changeLabel[item.kind]}
                  {item.dirty && <span className="text-[#A8741F]">· 本地有修改</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col">
            {change && <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[#EFF1F4] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[#3A3E44]">{change.file}</span>
                <span className="rounded-[4px] bg-[#F4F6F8] px-1.5 py-0.5 text-[9px] text-[#6B727A]">{changeLabel[change.kind]}</span>
                <span className="text-[9px] text-[#9AA0A8]">本地：{change.local === null ? "无缓冲区" : change.dirty ? "有未保存修改" : "与上次同步一致"}</span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-[#ECEEF1] border-b border-[#EFF1F4] text-[9px] text-[#90969E]">
                <div className="px-3 py-1">磁盘版本{change.disk === null ? "（已删除）" : ""}</div>
                <div className="px-3 py-1">本地缓冲区{local === null ? "（无文件）" : ""}</div>
              </div>
              <div className="h-[38vh] min-h-[220px]">
                <DiffEditor
                  height="100%"
                  theme="vs"
                  original={change.disk ?? ""}
                  modified={local ?? ""}
                  language={languageFor(change.file)}
                  originalModelPath={diskPath}
                  modifiedModelPath={localPath}
                  keepCurrentOriginalModel
                  keepCurrentModifiedModel
                  onMount={(editor) => { editor.getModel()?.original.setValue(change.disk ?? ""); editor.getModel()?.modified.setValue(local ?? ""); }}
                  options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 11, scrollBeyondLastLine: false, automaticLayout: true, occurrencesHighlight: "off" }}
                />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#ECEEF1] px-3 py-2">
                {change.kind === "added" && <button disabled={busy} className="btn h-[26px] px-2.5 text-[10px]" onClick={() => void run(() => disk.acceptDisk(change.file))}>Load disk file</button>}
                {change.kind === "deleted" && <button disabled={busy} className="btn h-[26px] px-2.5 text-[10px]" onClick={() => void run(() => disk.acceptDisk(change.file))}>Accept disk deletion</button>}
                {change.kind === "modified" && <button disabled={busy} className="btn h-[26px] px-2.5 text-[10px]" onClick={() => void run(() => disk.acceptDisk(change.file))}>Use disk version</button>}
                {change.kind === "deleted" && local !== null && <button disabled={busy} className="btn btn-primary h-[26px] px-2.5 text-[10px]" onClick={() => void run(() => disk.keepLocal(change.file))}>Recreate from local</button>}
                {change.kind !== "deleted" && local !== null && <button disabled={busy} className="btn btn-primary h-[26px] px-2.5 text-[10px]" onClick={() => void run(() => disk.keepLocal(change.file))}>Keep local and overwrite disk</button>}
              </div>
            </>}
          </div>
        </div>
      )}
      {error && <p role="alert" className="border-t border-[#ECEEF1] px-5 py-2 text-[11px] text-[#A8741F]">{error}</p>}
      <div className="flex items-center justify-between border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5 text-[9px] text-[#9AA0A8]">
        <span className="flex items-center gap-1.5"><span className="h-[4px] w-[4px] rounded-full bg-[#C08A2E]" />{changes.length} 个文件待处理 · 不会自动合并</span>
        <button className="btn h-[25px] px-2.5 text-[10px]" onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
