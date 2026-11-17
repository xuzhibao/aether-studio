import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useStudio } from "../store/studio";
import { CloseButton, Modal } from "./Dialogs";
export function ReviewChangesDialog() {
  const { dialog, setDialog, proposalReview, agentMessages, files, activeProjectId, resolveProposal } = useStudio();
  const proposal = agentMessages.find((m) => m.id === proposalReview?.messageId)?.proposals?.find((p) => p.id === proposalReview?.proposalId);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [proposal?.id]);
  if (!proposal || !proposalReview) return null;
  const change = proposal.changes[index];
  const conflict = proposal.projectId !== activeProjectId || proposal.changes.some((c) => (Object.hasOwn(files, c.path) ? files[c.path] : null) !== c.before);
  return <Modal open={dialog === "review-changes"} onOpenChange={(open) => !open && setDialog(null)} width={1000}>
    <div className="flex items-start justify-between p-5"><div><Dialog.Title className="text-sm font-semibold">文件修改预览</Dialog.Title><Dialog.Description className="mt-2 text-xs text-[#7D848C]">{proposal.summary} · 应用后仍需保存工程；不会自动编译、执行或烧录。</Dialog.Description></div><CloseButton onClick={() => setDialog(null)} /></div>
    <div className="flex gap-1 overflow-auto border-y border-[#ECEEF1] px-4 py-2">{proposal.changes.map((c, i) => <button key={c.path} className={`btn px-2 py-1 text-[11px] ${i === index ? "bg-[#EAF3FF]" : ""}`} onClick={() => setIndex(i)}>{c.path}{c.before === null ? " (新文件)" : ""}</button>)}</div>
    <div className="grid grid-cols-2 divide-x divide-[#ECEEF1]"><div><div className="px-4 py-2 text-[10px] text-[#90969E]">生成建议时的版本</div><pre className="h-[45vh] overflow-auto whitespace-pre-wrap p-4 text-[10px] leading-5 text-[#59616A]">{change.before ?? "（文件尚不存在）"}</pre></div><div><div className="px-4 py-2 text-[10px] text-[#90969E]">建议版本</div><pre className="h-[45vh] overflow-auto whitespace-pre-wrap bg-[#F7FBF8] p-4 text-[10px] leading-5 text-[#59616A]">{change.after}</pre></div></div>
    {conflict && <p role="alert" className="px-5 py-2 text-xs text-[#A67832]">工程或文件已改变，请重新生成修改建议，避免覆盖现有编辑。</p>}
    <div className="flex justify-end gap-2 border-t border-[#ECEEF1] px-5 py-3"><button className="btn px-3 py-1.5 text-xs" onClick={() => resolveProposal(proposalReview.messageId, proposal.id, false)}>拒绝建议</button><button disabled={conflict || proposal.status !== "pending"} className="btn btn-primary px-3 py-1.5 text-xs" onClick={() => resolveProposal(proposalReview.messageId, proposal.id, true)}>应用修改</button></div>
  </Modal>;
}
