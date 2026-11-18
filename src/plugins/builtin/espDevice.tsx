import { useCallback, useEffect, useState } from "react";
import { Cpu, RefreshCw, ShieldCheck, Usb } from "lucide-react";
import { classifyUsb, type EspInspectResult } from "../../../shared/esp";
import { isDesktop } from "../../lib/desktop";
import { useStudio } from "../../store/studio";
import { useDisk } from "../../store/disk";
import { useTransport } from "../../store/transport";
import type { TransportPort } from "../api";
import type { StudioPlugin } from "../api";

const hex = (value: number) => "0x" + value.toString(16).toUpperCase();

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2 py-0.5"><span className="w-[92px] flex-none text-[#90969E]">{label}</span><span className="min-w-0 break-all text-[#3B424A]">{children}</span></div>;
}

export function EspDevicePanel() {
  const taskRunning = useDisk((state) => state.tasks.some((task) => task.status === "running"));
  const io = useTransport();
  const setDialog = useStudio((state) => state.setDialog);
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EspInspectResult | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    const api = window.aether?.serial;
    if (!api) return;
    setLoading(true); setError("");
    void api.list().then((items) => {
      setPorts(items);
      setSelected((current) => items.some((item) => item.path === current) ? current : (items[0]?.path ?? ""));
    }, (reason) => setError(String(reason))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (isDesktop()) refresh(); }, [refresh]);
  const inspect = async () => {
    const api = window.aether?.esp;
    if (!api || !selected) return;
    setBusy(true); setError(""); setResult(null);
    try { setResult(await api.inspect(selected)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const portBusy = taskRunning || busy || ["connecting", "connected", "disconnecting"].includes(io.status);
  const usbClass = (port: TransportPort) => classifyUsb({
    vendorId: /VID[: ]+([0-9a-fA-F]{4})/.exec(port.detail ?? "")?.[1] ?? "",
    productId: /PID[: ]+([0-9a-fA-F]{4})/.exec(port.detail ?? "")?.[1] ?? "",
    manufacturer: port.label, product: "",
  });
  return <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="text-base font-semibold">ESP 设备（只读）</h1>
    <p className="mt-2 leading-5 text-[#90969E]">选择一个端口后显式触发检测。只运行 esptool 的 flash_id、0x8000 分区表读取和 eFuse 状态读取，不写 flash；检测结束会复位芯片。板型始终标记为未知：芯片型号与 USB 描述符都不能确定开发板。</p>
    {!isDesktop() && <p className="mt-3 rounded bg-[#FFF5E7] p-2 text-[#9A702C]">ESP 检测需要 Electron 桌面端。</p>}
    {isDesktop() && <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">端口
          <select aria-label="ESP 端口" className="input h-[26px] px-2" value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
            {!ports.length && <option value="">未枚举到端口</option>}
            {ports.map((port) => <option key={port.path} value={port.path}>{port.path} · {port.label}</option>)}
          </select>
        </label>
        <button className="btn px-2 py-1" onClick={refresh} disabled={loading || busy}><RefreshCw size={11} /> {loading ? "枚举中…" : "刷新端口"}</button>
        <button className="btn btn-primary px-3 py-1" disabled={!selected || portBusy} onClick={() => void inspect()}><Cpu size={11} /> {busy ? "检测中…" : "只读检测"}</button>
        <button className="btn px-2 py-1" onClick={() => setDialog("deploy")}>Deploy to Device</button>
      </div>
      {ports.length > 0 && <div className="mt-2 rounded-md border border-[#E9EBEE] p-2">
        {ports.map((port) => { const info = usbClass(port); return <div key={port.path} className="flex items-center gap-2 py-0.5 text-[10px]">
          <Usb size={10} className={info.kind === "native-usb" ? "text-[#2F7FD8]" : "text-[#9AA0A8]"} />
          <span className="font-mono">{port.path}</span><span>{port.label}</span><span className="text-[#90969E]">{port.detail}</span>
          <span className={info.kind === "native-usb" ? "text-[#2F7FD8]" : "text-[#9AA0A8]"}>{info.kind === "native-usb" ? "原生 USB · 不经过桥" : info.kind === "usb-uart-bridge" ? info.vendor : "厂商未知"}</span>
        </div>; })}
        <p className="mt-1 text-[9px] leading-5 text-[#90969E]">VID/PID 与厂商名称来自操作系统，只能区分原生 USB 与 USB-UART 桥，不能识别板型或固件。</p>
      </div>}
      {portBusy && !busy && <p className="mt-2 text-[10px] text-[#A8741F]">构建/上传任务或串口监视器正在使用端口，检测需先释放端口。</p>}
      {error && <p role="alert" className="mt-3 whitespace-pre-wrap text-[#A8741F]">{error}</p>}
      {result && <section data-esp-inspect={result.port} data-esp-error={result.error ? "1" : "0"} className="mt-4 rounded-lg border border-[#E5E8EC] p-3">
        {result.error ? <p role="alert" className="text-[#A8741F]">{result.error}</p> : <>
          <div className="flex flex-wrap items-center gap-2"><strong>检测结果</strong><span className="text-[#3B9A68]"><ShieldCheck size={11} /> 只读</span><span className="text-[10px] text-[#90969E]">{result.durationMs} ms · tool {result.tool.version || "?"}（{result.tool.source}）</span></div>
          <div className="mt-2 space-y-0.5">
            <Field label="端口">{result.port}{result.usb ? ` · VID:PID ${result.usb.vendorId}:${result.usb.productId}` : ""}</Field>
            <Field label="USB 类型">{result.usbClass.vendor || "未知"} · {result.usbClass.note}</Field>
            <Field label="芯片">{result.chip ? `${result.chip.name} ${result.chip.variant} · rev ${result.chip.revision} · 晶振 ${result.chip.crystalMhz ?? "?"} MHz` : "未识别"}</Field>
            <Field label="特性">{result.chip?.features.join("、") || "—"}{result.chip?.usbMode ? ` · ${result.chip.usbMode}` : ""}</Field>
            <Field label="Flash">{result.flash?.size ? `${result.flash.size / 1048576} MB（Manufacturer ${result.flash.manufacturer || "?"} / Device ${result.flash.device || "?"}）` : "未识别"}</Field>
            <Field label="板型">未知 — {result.board.note}</Field>
            <Field label="安全状态">{result.security ? `安全启动 ${result.security.secureBoot === null ? "?" : result.security.secureBoot} · flash 加密 ${result.security.flashEncryption === null ? "?" : result.security.flashEncryption} · 下载模式禁用 ${result.security.downloadModeDisabled === null ? "?" : result.security.downloadModeDisabled}（${result.security.source}）` : "未读取"}</Field>
          </div>
          <div className="mt-3">
            <p className="font-medium">板上分区表（0x8000）</p>
            {!result.partitions.valid ? <p className="mt-1 text-[#A8741F]">未读到有效分区表：{result.partitions.error}</p> : <table className="mt-1 w-full border-collapse text-[10px]">
              <thead><tr className="text-left text-[#90969E]"><th className="border-b border-[#EEF0F3] py-1">名称</th><th className="border-b border-[#EEF0F3]">类型</th><th className="border-b border-[#EEF0F3]">偏移</th><th className="border-b border-[#EEF0F3]">大小</th></tr></thead>
              <tbody>{result.partitions.entries.map((entry) => <tr key={entry.label + entry.offset} className="font-mono"><td className="py-0.5">{entry.label}</td><td>{entry.typeName}/{entry.subtypeName}</td><td>{hex(entry.offset)}</td><td>{hex(entry.size)}</td></tr>)}</tbody>
            </table>}
          </div>
          {result.notes.length > 0 && <ul className="mt-2 list-disc pl-4 text-[10px] text-[#90969E]">{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          <p className="mt-2 text-[10px] leading-5 text-[#90969E]">检测不会判断固件类型、板型或是否可安全烧录；部署时还会单独核对构建产物与写入地址。</p>
        </>}
      </section>}
    </>}
  </div>;
}

export const espDevicePlugin: StudioPlugin = {
  manifest: {
    id: "aether.esp.device", name: "ESP 设备检测", version: "0.4.0", type: "device", entry: "builtin/espDevice.tsx", enabled: true,
    description: "按端口显式触发只读的 esptool 检测：芯片、flash、板上分区表与安全状态；同时为部署前核对提供设备侧事实。使用 PlatformIO 自带的 tool-esptoolpy 或单独配置的 esptool。",
    settings: [{ key: "esptool.path", label: "esptool 路径（可选）", type: "tool-path", tool: "esptool", placeholder: "例如 C:/Users/you/.platformio/packages/tool-esptoolpy/esptool.py", help: "留空时依次使用环境变量 AETHER_ESPTOOL、PlatformIO 自带的 tool-esptoolpy（本机实测 4.9.0），最后查找 PATH 中的 esptool。指定 .py 时会用 PlatformIO 的 Python 解释器运行。" }],
    settingsHelp: "ESP 检测与部署前核对都只读。工具路径作为单个参数传给进程，不经过 shell；不支持 .bat、.cmd、.ps1。",
  },
  activate(api) {
    const desktop = () => {
      const esp = typeof window === "undefined" ? undefined : window.aether?.esp;
      if (!esp) throw new Error("ESP 检测需要 Electron 桌面端");
      return esp;
    };
    api.register("devices", {
      id: "esp32", name: "ESP32 / ESP32-C3 / ESP32-S3（esptool 只读）",
      inspect: (port) => desktop().inspect(port),
      // The UI preview; the authoritative checks run again inside esp.upload while the port is locked.
      preflight: (options) => desktop().preflight(options),
      uploadProvider: "esp.upload",
    });
    api.register("panels", { id: "esp.device", name: "ESP 设备", render: EspDevicePanel });
    api.register("commands", { id: "esp.openDevice", name: "ESP: 打开设备面板（只读检测）", run: () => useStudio.getState().setTab("panel:esp.device") });
  },
};
