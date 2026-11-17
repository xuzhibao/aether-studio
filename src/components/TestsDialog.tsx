import * as Dialog from "@radix-ui/react-dialog";
import { useStudio } from "../store/studio";
import { CloseButton, Modal } from "./Dialogs";
export function TestsDialog() {
  const { dialog, setDialog, console: lines, build } = useStudio();
  return <Modal open={dialog === "tests"} onOpenChange={(open) => !open && setDialog(null)}>
    <div className="p-5"><div className="flex justify-between"><Dialog.Title className="text-[14px] font-semibold">工程文件检查</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div><Dialog.Description className="my-4 text-[12px] leading-6 text-[#7D848C]">检查由工程绑定的工具链插件提供。当前 MicroPython 插件仅检查入口文件和 JSON，不编译固件、不运行硬件测试。</Dialog.Description><button className="btn px-3 py-1.5" onClick={build}>检查当前工程</button><div className="mt-4 space-y-2 text-[11px] text-[#7D848C]">{lines.filter((l) => l.source === "Build").map((l) => <p key={l.id}>{l.text}</p>)}</div></div>
  </Modal>;
}
