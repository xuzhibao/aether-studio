import { useEffect, useRef, useState } from "react";
import type { ToolStatus } from "../../shared/tools";

const sources: Record<ToolStatus["source"], string> = { setting: "插件设置", environment: "环境变量", path: "PATH" };

// Desktop tool configuration for plugin settings. The host owns storage; the plugin only names its tool.
export function ToolPathField({ tool, label, placeholder, help }: { tool: string; label: string; placeholder?: string; help?: string }) {
  const api = typeof window === "undefined" ? undefined : window.aether?.tools;
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const edited = useRef(false);
  useEffect(() => {
    if (!api) return;
    let live = true;
    const adopt = (list: ToolStatus[]) => {
      if (!live) return;
      const item = list.find((entry) => entry.id === tool);
      if (!item) return;
      // A background "settings changed" notification carries no version; keep the measured one.
      setStatus((previous) => previous && previous.executable === item.executable && !item.version && previous.version ? { ...item, version: previous.version } : item);
    };
    void api.list().then(async (list) => {
      adopt(list);
      const item = list.find((entry) => entry.id === tool);
      // A slow initial list must not overwrite a value the user already typed or saved.
      if (item && !edited.current) setValue(item.configured);
      const measured = await api.status(tool);
      if (live) setStatus(measured);
    }).catch((issue) => { if (live) setError(String(issue)); });
    const off = api.onChanged(adopt);
    return () => { live = false; off(); };
  }, [api, tool]);
  if (!api) return <div data-tool-id={tool} data-tool-available="false" className="text-[10px]">
    <p className="mb-1 font-medium">{label}</p>
    <p className="leading-5 text-[#90969E]">桌面工具仅在安装版（Electron）中可用；浏览器预览不能调用本机 PlatformIO 或 clangd。请在桌面端打开 Plugins → 本插件配置路径。</p>
  </div>;
  const save = async (next = value) => {
    setBusy(true); setError("");
    try { setStatus(await api.setPath(tool, next)); setStatus(await api.status(tool)); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(false); }
  };
  const browse = async () => {
    setError("");
    try { const picked = await api.pick(tool); if (picked) { edited.current = true; setValue(picked); await save(picked); } }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
  };
  const detect = async () => {
    setBusy(true); setError("");
    try { setStatus(await api.status(tool)); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(false); }
  };
  return <div data-tool-id={tool} data-tool-available={status ? String(status.available) : "unknown"} data-tool-source={status?.source ?? "unknown"} className="text-[10px]">
    <p className="mb-1 font-medium">{label}</p>
    <div className="flex gap-1.5">
      <input aria-label={label} className="input w-full text-[11px]" placeholder={placeholder} value={value} spellCheck={false}
        onChange={(event) => { edited.current = true; setValue(event.target.value); }}
        onBlur={() => { if (value.trim() !== (status?.configured ?? "")) void save(); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
      <button type="button" className="btn whitespace-nowrap px-2 py-1" aria-label={`选择 ${label}`} onClick={browse} disabled={busy}>浏览…</button>
      <button type="button" className="btn whitespace-nowrap px-2 py-1" aria-label={`检测 ${label}`} onClick={detect} disabled={busy}>检测</button>
    </div>
    <p role="status" className="mt-1 break-all text-[9px] leading-5 text-[#90969E]">
      {status ? (status.available ? `可用 · 来源 ${sources[status.source]} · ${status.executable}${status.version ? ` · 版本 ${status.version}` : " · 版本未检测（点“检测”实际运行 --version）"}` : `不可用 · ${status.error}`) : "尚未读取工具状态"}
    </p>
    {status && !status.configured && <p className="mt-1 leading-5 text-[#90969E]">未保存路径。优先级：此处设置 → 环境变量 {status.env} → PATH 中的 {status.executable}。</p>}
    {help && <p className="mt-1 leading-5 text-[#90969E]">{help}</p>}
    {error && <p role="alert" className="mt-1 rounded bg-[#FFF5E7] p-1.5 text-[#9A702C]">{error}</p>}
  </div>;
}
