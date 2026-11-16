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
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, Record<string, string>>>({});
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const revision = registry.getRevision();
  const transport = registry.get("transports", selected);
  const busy = ["connecting", "connected", "disconnecting"].includes(io.status);
  const address = addresses[selected] ?? "";
  const parameters = Object.fromEntries(transport?.parameters.map((field) => [field.key, settings[selected]?.[field.key] ?? field.initial]) ?? []);
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    if (!registry.get("transports", selected)) setSelected(registry.all("transports")[0]?.id ?? "");
  }, [revision, selected]);
  useEffect(() => {
    if (dialog !== "devices") return;
    let current = true;
    setPorts([]); setError(""); setLoading(!!transport?.list && !transport.unavailable);
    if (transport?.list && !transport.unavailable) void transport.list().then((ports) => { if (current) setPorts(ports); }, (error) => { if (current) setError(String(error)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [dialog, selected, revision, refreshToken]);
  return <Modal open={dialog === "devices"} onOpenChange={(open) => !open && setDialog(null)} onOpenAutoFocus={(event) => { event.preventDefault(); addressRef.current?.focus(); }}>
    <div className="p-5">
      <div className="flex justify-between"><Dialog.Title className="text-[14px] font-semibold">Devices</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div>
      <Dialog.Description className="mt-3 text-[11px] leading-6 text-[#7D848C]">选择通信插件和地址，建立连接后在 Serial Monitor 收发数据。Demo Simulation 独立运行。</Dialog.Description>
      {!transports.length ? <p className="mt-4 text-xs text-[#9A702C]">没有已启用的通信插件。</p> : <form className="mt-4 space-y-3 text-[11px]" onSubmit={(event) => { event.preventDefault(); if (!busy && transport && !transport.unavailable) void io.connect(selected, { address: address.trim(), parameters }); }}>
        <label className="block">通信插件<select aria-label="通信插件" disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)} className="input mt-1 w-full">{transports.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {transport?.unavailable && <p role="status" className="rounded bg-[#FFF5E7] p-2 text-[#9A702C]">{transport.unavailable}</p>}
        <label className="block">{transport?.endpoint.label}<input ref={addressRef} aria-label={transport?.endpoint.label} list={transport?.list ? "transport-addresses" : undefined} disabled={busy || !!transport?.unavailable} value={address} onChange={(event) => setAddresses({ ...addresses, [selected]: event.target.value })} placeholder={transport?.endpoint.placeholder} className="input mt-1 w-full" /></label>
        <datalist id="transport-addresses">{ports.map((port) => <option key={port.path} value={port.path}>{port.label}</option>)}</datalist>
        <div className="flex items-end gap-2">{transport?.parameters.map((field) => <label key={field.key} className="block flex-1">{field.label}<input aria-label={field.label} type={field.type} min={field.min} step={field.type === "number" ? "1" : undefined} disabled={busy} value={parameters[field.key]} onChange={(event) => setSettings({ ...settings, [selected]: { ...settings[selected], [field.key]: event.target.value } })} className="input mt-1 w-full" /></label>)}<div className="flex flex-1 justify-end gap-2">{transport?.list && <button type="button" className="btn px-3 py-1.5" disabled={loading || busy || !!transport.unavailable} onClick={() => setRefreshToken((token) => token + 1)}>{loading ? "正在枚举…" : "刷新端口"}</button>}<button type="submit" className="btn btn-primary px-3 py-1.5" disabled={busy || !address.trim() || !transport || !!transport.unavailable}>建立连接</button></div></div>
        <p className="text-[10px] leading-5 text-[#90969E]">{transport?.description}</p>
        {!loading && transport?.list && !transport.unavailable && ports.length === 0 && <p className="text-[10px] text-[#90969E]">未枚举到端口，可手动输入路径。</p>}
      </form>}
      <div className="mt-4 rounded-md border border-[#E9EBEE] p-3 text-[11px]" role="status">{io.status === "connected" ? `已连接 ${io.label}` : io.status === "connecting" ? "正在建立连接…" : io.status === "disconnecting" ? "正在断开…" : "未建立连接"}</div>
      {(error || io.error) && <p role="alert" className="mt-3 whitespace-pre-wrap text-[11px] text-[#A8741F]">{error || io.error}</p>}
      <div className="mt-4 flex justify-end gap-2 text-[11px]"><button className="btn px-3 py-1.5" onClick={() => setDialog("plugins")}>管理插件</button>{["connecting", "connected"].includes(io.status) && <button className="btn px-3 py-1.5" onClick={() => void io.disconnect()}>断开连接</button>}<button className="btn px-3 py-1.5" onClick={() => { setDialog(null); setTab("serial"); }}>打开 Serial Monitor</button></div>
    </div>
  </Modal>;
}
