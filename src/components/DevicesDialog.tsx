import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useStudio } from "../store/studio";
import { useTransport } from "../store/transport";
import { usePlugins } from "../plugins/usePlugins";
import type { TransportPort } from "../plugins/api";
import { CloseButton, Modal } from "./Dialogs";

export function DevicesDialog() {
  const { dialog, setDialog, setTab } = useStudio();
  const registry = usePlugins();
  const transports = registry.all("transports");
  const io = useTransport();
  const [selected, setSelected] = useState(() => transports[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [baud, setBaud] = useState("115200");
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);
  const revision = registry.getRevision();
  const transport = registry.get("transports", selected);
  const busy = ["connecting", "connected", "disconnecting"].includes(io.status);
  const refresh = async () => {
    if (!transport || transport.unavailable) return;
    setLoading(true); setError("");
    try { setPorts(await transport.list()); }
    catch (error) { setError(String(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (!registry.get("transports", selected)) setSelected(registry.all("transports")[0]?.id ?? "");
  }, [revision, selected]);
  useEffect(() => {
    if (dialog !== "devices") return;
    setPorts([]); setError("");
    void refresh();
  }, [dialog, selected]);
  return <Modal open={dialog === "devices"} onOpenChange={(open) => !open && setDialog(null)} onOpenAutoFocus={(event) => { event.preventDefault(); pathRef.current?.focus(); }}>
    <div className="p-5">
      <div className="flex justify-between"><Dialog.Title className="text-[14px] font-semibold">Devices</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div>
      <Dialog.Description className="mt-3 text-[11px] leading-6 text-[#7D848C]">手动连接串口后，可在 Serial Monitor 查看接收数据并发送文本。打开端口不代表已识别开发板或固件；Demo Simulation 独立运行。</Dialog.Description>
      {!transports.length ? <p className="mt-4 text-xs text-[#9A702C]">没有已启用的通信插件。</p> : <form className="mt-4 space-y-3 text-[11px]" onSubmit={(event) => { event.preventDefault(); if (!busy && transport && !transport.unavailable) void io.connect(selected, { path: path.trim(), baudRate: Number(baud) }); }}>
        <label className="block">通信插件<select aria-label="通信插件" disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)} className="input mt-1 w-full">{transports.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {transport?.unavailable && <p role="status" className="rounded bg-[#FFF5E7] p-2 text-[#9A702C]">{transport.unavailable}</p>}
        <label className="block">端口路径<input ref={pathRef} aria-label="端口路径" list="serial-ports" disabled={busy || !!transport?.unavailable} value={path} onChange={(event) => setPath(event.target.value)} placeholder="COM3 / /dev/ttyUSB0 / /dev/cu.usbserial…" className="input mt-1 w-full" /></label>
        <datalist id="serial-ports">{ports.map((port) => <option key={port.path} value={port.path}>{port.label}</option>)}</datalist>
        <div className="flex items-end gap-2"><label className="block flex-1">波特率<input aria-label="波特率" type="number" min="1" step="1" disabled={busy} value={baud} onChange={(event) => setBaud(event.target.value)} className="input mt-1 w-full" /></label><button type="button" className="btn px-3 py-1.5" disabled={loading || busy || !transport || !!transport.unavailable} onClick={() => void refresh()}>{loading ? "正在枚举…" : "刷新端口"}</button><button type="submit" className="btn btn-primary px-3 py-1.5" disabled={busy || !path.trim() || !transport || !!transport.unavailable}>连接端口</button></div>
        <p className="text-[10px] text-[#90969E]">8 data bits · no parity · 1 stop bit · no flow control。也可手动填写未枚举到的端口路径。</p>
        {!loading && transport && !transport.unavailable && ports.length === 0 && <p className="text-[10px] text-[#90969E]">未枚举到端口。请连接 USB 串口设备，或手动输入端口路径。</p>}
      </form>}
      <div className="mt-4 rounded-md border border-[#E9EBEE] p-3 text-[11px]" role="status">{io.status === "connected" ? `已连接 ${io.path} · ${io.baudRate} baud` : io.status === "connecting" ? "正在打开端口…" : io.status === "disconnecting" ? "正在断开…" : "未连接端口"}</div>
      {(error || io.error) && <p role="alert" className="mt-3 whitespace-pre-wrap text-[11px] text-[#A8741F]">{error || io.error}</p>}
      <div className="mt-4 flex justify-end gap-2 text-[11px]"><button className="btn px-3 py-1.5" onClick={() => setDialog("plugins")}>管理插件</button>{["connecting", "connected"].includes(io.status) && <button className="btn px-3 py-1.5" onClick={() => void io.disconnect()}>断开端口</button>}<button className="btn px-3 py-1.5" onClick={() => { setDialog(null); setTab("serial"); }}>打开 Serial Monitor</button></div>
    </div>
  </Modal>;
}
