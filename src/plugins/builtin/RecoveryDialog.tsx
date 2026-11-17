import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ArchiveRestore, Clock3, FolderX, HardDrive, Trash2 } from "lucide-react";
import { CloseButton, Modal } from "../../components/Dialogs";
import { useRecovery } from "../../store/recovery";
import { useDisk } from "../../store/disk";
import { useProjectFiles } from "./projectFilesState";
import { cn } from "../../lib/utils";

const time = (value: string) => value ? new Date(value).toLocaleString("zh-CN") : "未知时间";
const bytes = (value: number) => value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(value / 1024)) + " KB";

export function RecoveryDialog() {
  const dialog = useProjectFiles((state) => state.dialog);
  const close = useProjectFiles((state) => state.close);
  const { drafts, preview, error, loading, restoring, refresh, previewDraft, restore, discard, later } = useRecovery();
  const initial = dialog?.kind === "recovery" ? dialog.root : undefined;
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [file, setFile] = useState<string | null>(null);
  const diskRoot = useDisk((state) => state.root);
  const diskFiles = useDisk((state) => state.diskFiles);
  const active = drafts.find((draft) => draft.root === selected) ?? drafts[0];
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!drafts.length) return;
    if (!selected || !drafts.some((draft) => draft.root === selected)) setSelected(drafts[0].root);
  }, [drafts, selected]);
  useEffect(() => {
    if (!active) return;
    setFile(null);
    void previewDraft(active.root);
  }, [active?.root]);
  const text = preview && file && Object.hasOwn(preview.context.files, file) ? preview.context.files[file] : "";
  // A disk change during the crash window is shown before restoring and stays a per-file conflict afterwards.
  const changedOnDisk = preview && diskRoot === preview.root ? Object.entries(preview.disk ?? {}).filter(([name, value]) => diskFiles[name] !== value).map(([name]) => name) : [];
  return (
    <Modal open onOpenChange={(open) => { if (!open) later(); }} width={1000}>
      <div className="flex items-start justify-between px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[14px] font-semibold text-[#23272C]">恢复未保存内容</Dialog.Title>
          <Dialog.Description className="mt-1 text-[10.5px] leading-5 text-[#7D848C]">
            这些草稿来自上次异常退出时尚未保存的缓冲区，存放在应用用户数据目录，不在工程目录内。恢复只会进入缓冲区，不会自动写入磁盘；保存时仍会检查磁盘外部修改。
          </Dialog.Description>
        </div>
        <CloseButton onClick={later} />
      </div>
      <div className="grid min-h-[380px] grid-cols-[268px_minmax(0,1fr)] border-t border-[#ECEEF1]">
        <div className="max-h-[54vh] overflow-y-auto border-r border-[#ECEEF1] p-2">
          {loading && !drafts.length && <p className="px-2 py-3 text-[10px] text-[#90969E]">正在读取恢复草稿…</p>}
          {!loading && !drafts.length && <p className="px-2 py-3 text-[10px] text-[#90969E]">没有待处理的恢复草稿。</p>}
          {drafts.map((draft) => (
            <button key={draft.root} data-recovery-root={draft.root} aria-label={"恢复草稿 " + draft.root} className={cn("mb-1 w-full rounded-[6px] px-2.5 py-2 text-left", active?.root === draft.root ? "bg-[#EAF3FF]" : "hover:bg-[#F3F5F8]")} onClick={() => setSelected(draft.root)}>
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[#2B3036]"><HardDrive size={11} className="text-[#7C838C]" />{draft.projectName}</span>
              <span className="mt-1 block break-all font-mono text-[9px] text-[#8A9098]">{draft.root}</span>
              <span className="mt-1 flex flex-wrap items-center gap-2 text-[8.5px] text-[#9AA0A8]"><Clock3 size={9} />{time(draft.updatedAt)}<span>·</span>{draft.fileCount} 个文件<span>·</span>{bytes(draft.size)}</span>
              {draft.error && <span className="mt-1 flex items-center gap-1 text-[9px] text-[#B0402F]"><AlertTriangle size={9} />草稿损坏</span>}
              {!draft.rootExists && <span className="mt-1 flex items-center gap-1 text-[9px] text-[#A8741F]"><FolderX size={9} />工程目录已不存在</span>}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-col">
          {active ? <>
            <div className="border-b border-[#EFF1F4] px-3 py-2">
              <p className="text-[12px] font-medium text-[#2B3036]">{active.projectName}</p>
              <p className="mt-0.5 break-all font-mono text-[9px] text-[#90969E]">{active.root}</p>
              <p className="mt-1 text-[9px] text-[#9AA0A8]">
                {active.rootExists ? "工程目录存在；恢复后保存仍受外部修改检查保护。" : "工程目录已不存在；恢复后只能使用 Save project to folder 保存到新目录。"}
                {" "}打开标签页：{active.openTabs.filter((tab) => tab !== "circuit" && tab !== "serial").join("、") || "无"}
              </p>
              {preview && <p className="mt-1 text-[9px] text-[#9AA0A8]">电路上下文：{preview.context.components.length} 个元件 · {preview.context.wires.length} 条连线 · 内容版本 {preview.revision}</p>}
              {changedOnDisk.length > 0 && <p role="alert" className="mt-2 rounded-[5px] bg-[#FFF7E8] px-2 py-1 text-[9px] leading-4 text-[#966A22]">磁盘在草稿写入后已变化：{changedOnDisk.join("、")}。恢复后保存会被拦住，需要先按文件选择磁盘版本或保留本地内容。</p>}
            </div>
            {active.error ? <div className="m-4 rounded-[6px] border border-[#F2D9D4] bg-[#FDF1EF] p-3 text-[10px] leading-5 text-[#A6402F]">
              <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={11} />{active.error}</p>
              <p className="mt-1 text-[#9C6A60]">草稿文件保留在用户数据目录；不会读取或修改工程源码。你可以丢弃此草稿，或先备份草稿文件再手动检查。</p>
            </div> : <div className="grid min-h-0 flex-1 grid-cols-[210px_minmax(0,1fr)]">
              <div className="max-h-[46vh] overflow-y-auto border-r border-[#EFF1F4] p-2">
                {preview ? Object.keys(preview.context.files).sort().map((name) => <button key={name} aria-label={"预览 " + name} className={cn("block w-full truncate rounded-[4px] px-2 py-1 text-left font-mono text-[9.5px]", file === name ? "bg-[#EAF3FF] text-[#1F5FA8]" : "text-[#59616A] hover:bg-[#F4F6F8]")} onClick={() => setFile(name)}>{name}</button>) : <p className="p-2 text-[9.5px] text-[#90969E]">正在读取草稿…</p>}
              </div>
              <div className="flex min-h-0 min-w-0 flex-col">
                {file ? <>
                  <p className="border-b border-[#EFF1F4] px-3 py-1.5 font-mono text-[9.5px] text-[#59616A]">{file}{text.length > 8000 ? " · 仅显示前 8000 字符" : ""}</p>
                  <pre data-recovery-preview={file} className="max-h-[42vh] min-h-[220px] overflow-auto whitespace-pre-wrap bg-[#FAFBFC] p-3 font-mono text-[10px] leading-5 text-[#33383F]">{text.slice(0, 8000)}</pre>
                </> : <p className="p-3 text-[10px] text-[#90969E]">选择左侧文件预览草稿内容。预览不会写入磁盘。</p>}
              </div>
            </div>}
          </> : <p className="p-4 text-[10px] text-[#90969E]">选择左侧恢复草稿查看内容。</p>}
          {error && <p role="alert" className="border-t border-[#ECEEF1] px-4 py-2 text-[10px] text-[#A8741F]">{error}</p>}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <span className="text-[9px] text-[#9AA0A8]">草稿与正常工程保存分开；丢弃草稿不会删除工程文件。</span>
        <div className="flex gap-2">
          <button className="btn h-[26px] px-2.5 text-[10px]" onClick={later}>稍后处理</button>
          <button className="btn h-[26px] px-2.5 text-[10px] text-[#B0402F]" disabled={!active || restoring} onClick={() => void discard(active?.root)}><Trash2 size={10} />丢弃此草稿</button>
          <button className="btn btn-primary h-[26px] px-3 text-[10px]" disabled={!preview || !active || restoring || !!active.error} onClick={() => { void restore(); }}><ArchiveRestore size={11} />{restoring ? "恢复中…" : "恢复此草稿"}</button>
        </div>
      </div>
    </Modal>
  );
}
