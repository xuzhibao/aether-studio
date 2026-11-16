import * as Dialog from "@radix-ui/react-dialog";
import { useStudio } from "../store/studio";
import { CloseButton, Modal } from "./Dialogs";
export function DevicesDialog() {
  const { dialog, setDialog } = useStudio();
  return <Modal open={dialog === "devices"} onOpenChange={(open) => !open && setDialog(null)}>
    <div className="p-5"><div className="flex justify-between"><Dialog.Title className="text-[14px] font-semibold">Devices</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div><Dialog.Description className="mt-4 text-[12px] leading-6 text-[#7D848C]">无真实设备连接。当前工程使用 Demo Simulation 生成数据。串口、USB 和网络通信插件尚未实现。</Dialog.Description><button className="btn mt-4 px-3 py-1.5" onClick={() => setDialog("plugins")}>管理插件</button></div>
  </Modal>;
}
