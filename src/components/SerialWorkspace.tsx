import { useEffect, useState } from "react";
import { Activity, Download, Pause, Play, Send, Trash2, Usb } from "lucide-react";
import { useStudio } from "../store/studio";
import { useTransport } from "../store/transport";
import type { SerialLine } from "../types";
import { SerialList } from "./SerialLines";
import { cn } from "../lib/utils";
import { isDesktop } from "../lib/desktop";
import { exportSerialLog, useSerialLogSnapshot } from "../store/serialLog";

export function SerialWorkspace() {
  const { serial, runState, pauseSimulation, runSimulation, setDialog, addToast } = useStudio();
  const io = useTransport();
  const [source, setSource] = useState<"demo" | "device">(() => io.status === "connected" ? "device" : "demo");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "data" | "warn">("all");
  const [frozen, setFrozen] = useState<SerialLine[] | null>(null);
  const [command, setCommand] = useState("");
  const [ending, setEnding] = useState("\n");
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The retained native session log is independent of Pause/filter/Clear and of the visible source.
  const logSession = useSerialLogSnapshot();
  const canExportLog = isDesktop() && !!logSession;
  useEffect(() => { if (io.status === "connected") { setSource("device"); setFrozen(null); } }, [io.status]);
  const live = source === "demo" ? serial : io.lines;
  const lines = (frozen ?? live).filter((line) => line.text.toLowerCase().includes(query.toLowerCase()));
  const send = async () => {
    if (!command || sending || source !== "device") return;
    setSending(true);
    try { await io.send(command + ending); setCommand(""); }
    catch (error) { addToast({ title: "串口发送失败", detail: String(error), tone: "warn" }); }
    finally { setSending(false); }
  };
  const exportLog = async () => {
    if (exporting || !canExportLog) return;
    setExporting(true);
    try {
      const result = await exportSerialLog();
      if (result.status === "saved") addToast({ title: "串口诊断日志已保存", detail: result.path, tone: "success" });
      else if (result.status === "cancelled") addToast({ title: result.reason === "invalidated" ? "串口会话已变化，未导出日志" : "已取消导出串口诊断日志" });
      else addToast({ title: "串口诊断日志导出失败", detail: result.error, tone: "warn" });
    } finally { setExporting(false); }
  };
  return <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#FCFCFD]">
    <div className="flex h-[48px] flex-none items-center gap-2.5 border-b border-[#E9EBEE] px-3.5">
      <Activity size={16} className="text-[#47617D]" /><div><div className="text-[12px] font-semibold">Serial Monitor</div><div className="mt-0.5 text-[9px] text-[#969CA4]">{source === "demo" ? "Demo Simulation · Generated data · 不连接设备" : `${io.label || "未建立连接"} · ${io.status} · RX ${io.receivedBytes} bytes · TX ${io.sentBytes} bytes`}</div></div>
      <div className="ml-auto flex items-center gap-2"><select aria-label="Serial source" value={source} onChange={(event) => { setSource(event.target.value as typeof source); setFrozen(null); }} className="input text-[10px]"><option value="demo">Demo Simulation</option><option value="device">Device transport</option></select><button className="btn px-2 py-1 text-[10px]" onClick={() => setDialog("devices")}><Usb size={12} /> Manage connection</button>{source === "demo" && <button className="btn px-2 py-1 text-[10px]" onClick={() => runState === "running" ? pauseSimulation() : runSimulation()}>{runState === "running" ? "Pause simulation" : "Run simulation"}</button>}</div>
    </div>
    {source === "device" && io.sendHint && <p className="border-b border-[#EEF0F3] px-3 py-1 text-[9px] text-[#90969E]">{io.sendHint}</p>}
    <div className="flex h-[34px] flex-none items-center gap-2 border-b border-[#EEF0F3] px-3"><div className="seg">{([ ["all", "All"], ["data", "Data"], ["warn", "Warnings"] ] as const).map(([value, label]) => <button key={value} className={cn("seg-item h-[20px]", filter === value && "active")} onClick={() => setFilter(value)}>{label}</button>)}</div><input aria-label="Filter serial output" placeholder="Filter output…" value={query} onChange={(event) => setQuery(event.target.value)} className="input ml-auto text-[10px]" /><button className="icon-btn" aria-label={frozen ? "Resume display" : "Pause display"} onClick={() => setFrozen(frozen ? null : [...live])}>{frozen ? <Play size={12} /> : <Pause size={12} />}</button><button className="icon-btn" aria-label="Export serial diagnostic log" data-serial-log-export disabled={!canExportLog || exporting} aria-busy={exporting} title={canExportLog ? "导出当前或最近结束的原生串口会话诊断记录（有界，可能含丢弃标记；与当前显示的 Demo/WebSocket 来源无关）" : "仅桌面端原生串口会话可导出"} onClick={() => void exportLog()}><Download size={12} /></button><button className="icon-btn" aria-label="Clear serial output" onClick={() => { if (source === "demo") useStudio.setState({ serial: [] }); else io.clear(); setFrozen(null); }}><Trash2 size={12} /></button></div>
    {source === "device" && io.error && <p role="alert" className="border-b border-[#EEF0F3] px-3 py-2 text-[11px] text-[#A8741F]">{io.error}</p>}
    {source === "device" && io.status !== "connected" && <p className="px-3 py-2 text-[11px] text-[#90969E]">连接未建立。请在 Manage connection 中选择通信插件和地址；历史记录仍可查看。</p>}
    {source === "device" && io.status === "connected" && io.receivedBytes === 0 && <p className="border-b border-[#EEF0F3] px-3 py-2 text-[11px] leading-5 text-[#90969E]">已连接但尚未收到任何字节。上传退出码 0 只说明 esptool 命令结束。ESP32-C3 原生 USB-Serial/JTAG 需要固件把 Serial 指向 USB（模板中的 ARDUINO_USB_CDC_ON_BOOT=1），或按 RST 复位后重试。</p>}
    {source === "device" && io.status === "error" && <div className="flex items-center gap-2 border-b border-[#EEF0F3] px-3 py-2 text-[11px] text-[#A8741F]"><span>连接已中断，设备可能重新枚举（原生 USB 常见）。</span><button className="btn px-2 py-1 text-[10px]" onClick={() => setDialog("devices")}>重新连接…</button></div>}
    <div className="min-h-0 flex-1 overflow-hidden bg-white"><SerialList key={source} lines={lines} filter={filter} follow={!frozen} /></div>
    <form className="flex h-[44px] flex-none items-center gap-2 border-t border-[#E9EBEE] px-3" onSubmit={(event) => { event.preventDefault(); void send(); }}><span className="text-[10px] text-[#007AFF]">TX</span><input aria-label="Serial text" disabled={source !== "device" || io.status !== "connected" || sending} value={command} onChange={(event) => setCommand(event.target.value)} placeholder={source === "demo" ? "Demo Simulation 不执行输入；切换 Device transport 收发串口数据" : "发送文本到当前连接…"} className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none disabled:opacity-60" /><select aria-label="Line ending" value={ending} onChange={(event) => setEnding(event.target.value)} className="input text-[10px]"><option value="">No ending</option><option value={"\n"}>LF</option><option value={"\r\n"}>CRLF</option></select><button type="submit" className="btn px-2 py-1 text-[10px]" disabled={source !== "device" || io.status !== "connected" || !command || sending}><Send size={11} />{sending ? "Sending…" : "Send"}</button></form>
  </div>;
}
