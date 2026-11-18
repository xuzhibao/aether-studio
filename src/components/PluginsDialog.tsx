import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Puzzle } from "lucide-react";
import { useStudio } from "../store/studio";
import { usePlugins } from "../plugins/usePlugins";
import type { CapabilityMap, ProviderTestResult } from "../plugins/api";
import { CloseButton, Modal } from "./Dialogs";
import { ToolPathField } from "./ToolPathField";

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; result: ProviderTestResult }
  | { status: "error"; message: string }
  | { status: "cancelled"; timedOut: boolean };

/**
 * A real round trip through the provider's own adapter, cancelled when the dialog closes or the user
 * asks to stop. The displayed state starts at idle and only becomes success after a parsed response.
 */
function ProviderConnectionTest({ provider, active, endpoint, model, apiKey }: { provider: CapabilityMap["providers"]; active: boolean; endpoint: string; model: string; apiKey: string }) {
  const [state, setState] = useState<TestState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const live = useRef(true);
  // StrictMode runs setup → cleanup → setup; the ref must be restored on the second setup.
  useEffect(() => { live.current = true; return () => { live.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (active) setState({ status: "idle" }); else controller.current?.abort(); }, [active]);
  useEffect(() => {
    // A result belongs to the values that produced it: editing the form cancels the in-flight probe
    // and returns to idle, so an old response can never be shown as a success for new settings.
    const running = controller.current;
    controller.current = null;
    running?.abort();
    setState({ status: "idle" });
  }, [endpoint, model, apiKey]);
  const start = async () => {
    if (!provider.test || state.status === "testing") return;
    const run = new AbortController();
    controller.current = run;
    setState({ status: "testing" });
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; run.abort(); }, 15000);
    try {
      const result = await provider.test(run.signal);
      if (!live.current || controller.current !== run) return;
      setState({ status: "success", result });
    } catch (error) {
      if (!live.current || controller.current !== run) return;
      if (run.signal.aborted) setState({ status: "cancelled", timedOut });
      else setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      window.clearTimeout(timer);
      if (controller.current === run) controller.current = null;
    }
  };
  return <div data-provider-test={state.status} className="rounded-[6px] border border-[#E5E8EC] bg-[#FAFBFC] p-2.5 text-[10px]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-medium text-[#2B3036]">测试连接</span>
      <span className="flex gap-1.5">
        <button type="button" className="btn px-2 py-1" disabled={!provider.test || state.status === "testing"} onClick={() => void start()}>{state.status === "testing" ? "正在测试…" : "测试连接"}</button>
        {state.status === "testing" && <button type="button" className="btn px-2 py-1" onClick={() => controller.current?.abort()}>取消测试</button>}
      </span>
    </div>
    <p className="mt-1 leading-5 text-[#90969E]">使用表单当前的 endpoint、模型和会话 Key 发送一条不含工程内容的最小请求（最多 15 秒，可取消）。不会修改工程、不会写入 Key、也不会保存成功状态。</p>
    {state.status === "success" && <p role="status" className="mt-1.5 text-[#2B7A4B]">连接成功 · 响应模型 {state.result.model} · {state.result.latencyMs} ms · {state.result.detail}</p>}
    {state.status === "error" && <p role="alert" className="mt-1.5 break-words text-[#A8741F]">连接失败：{state.message}</p>}
    {state.status === "cancelled" && <p role="status" className="mt-1.5 text-[#7D848C]">{state.timedOut ? "测试超时（15 秒），已取消请求。" : "已取消测试；没有生成构建、任务或文件。"}</p>}
    <p className="mt-1.5 leading-5 text-[#90969E]">API Key 只保存在本次会话内存；关闭或重启应用后需重新填写。endpoint 和模型会保存在设置中。</p>
  </div>;
}

export function PluginsDialog() {
  const { dialog, setDialog, addToast } = useStudio();
  const registry = usePlugins();
  const [selected, setSelected] = useState(() => registry.list()[0].manifest.id);
  const [error, setError] = useState("");
  const installed = registry.list();
  const current = installed.find((p) => p.manifest.id === selected)!;
  const providerId = current.capabilities.find((capability) => capability.startsWith("providers/"))?.slice("providers/".length);
  const provider = providerId ? registry.get("providers", providerId) : undefined;
  const toggle = () => {
    setError("");
    try { current.enabled ? registry.disable(selected) : registry.enable(selected); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <Modal open={dialog === "plugins"} onOpenChange={(open) => !open && setDialog(null)} width={760}>
      <div className="flex items-center gap-3 px-5 py-4">
        <Puzzle size={22} className="text-[#3F6FA5]" />
        <div className="flex-1"><Dialog.Title className="text-[14px] font-semibold">Plugins</Dialog.Title><Dialog.Description className="mt-1 text-[10px] text-[#90969E]">本地内置插件 · {installed.filter((p) => p.enabled).length} / {installed.length} 已启用</Dialog.Description></div>
        <CloseButton onClick={() => setDialog(null)} />
      </div>
      <div className="grid grid-cols-[235px_1fr] border-t border-[#ECEEF1]">
        <div className="max-h-[65vh] space-y-1 overflow-y-auto border-r border-[#ECEEF1] bg-[#FAFBFC] p-2">
          {installed.map(({ manifest, enabled }) => <button key={manifest.id} onClick={() => { setSelected(manifest.id); setError(""); }} className={`w-full rounded-md p-2.5 text-left ${selected === manifest.id ? "bg-[#EAF3FF]" : "hover:bg-[#F0F2F5]"}`}>
            <span className="flex items-center justify-between text-[11px] font-medium">{manifest.name}<span className={`ml-1 h-1.5 w-1.5 flex-none rounded-full ${enabled ? "bg-[#2B9661]" : "bg-[#B9BEC5]"}`} /></span>
            <span className="mt-1 block text-[9px] text-[#90969E]">{manifest.type} · v{manifest.version} · {enabled ? "已启用" : "已停用"}</span>
          </button>)}
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-5 text-[11px] text-[#5A626C]">
          <div className="flex items-start justify-between gap-2"><div><h2 className="text-[14px] font-semibold text-[#2B3036]">{current.manifest.name}</h2><p className="mt-1 font-mono text-[9px]">{current.manifest.id}</p></div><button className="btn px-3 py-1" onClick={toggle}>{current.enabled ? "停用" : "启用"}</button></div>
          <p className="mt-4 leading-6">{current.manifest.description}</p>
          <p className="mt-3 text-[10px]">类型：{current.manifest.type} · 版本：{current.manifest.version}</p>
          <p className="mt-2 break-all text-[10px]">入口：{current.manifest.entry}</p>
          <p className="mt-2 text-[10px]">依赖：{current.manifest.dependencies?.join(", ") || "无"}</p>
          <h3 className="mb-2 mt-4 font-semibold">已注册能力</h3>
          <ul className="space-y-1 break-all font-mono text-[9px]">{current.capabilities.map((c) => <li key={c}>{c}</li>)}</ul>
          {!current.enabled && <p className="text-[10px]">已停用，贡献的功能和 UI 已移除。工程内容仍保留。</p>}
          {current.manifest.type === "board" && current.enabled && <button className="btn btn-primary mt-4 px-3 py-1.5" onClick={() => setDialog("new-project")}>使用此开发板创建工程</button>}
          {current.manifest.settings && <div className="mt-4 space-y-3 border-t border-[#ECEEF1] pt-4">
            <h3 className="font-semibold">插件设置</h3>
            {current.manifest.presets?.length ? <div className="rounded-[6px] border border-[#E5E8EC] bg-[#FAFBFC] p-2.5">
              <p className="font-medium text-[#2B3036]">快速填入（不会自动连接）</p>
              {current.manifest.presets.map((preset) => <div key={preset.id} className="mt-1.5 flex flex-wrap items-center gap-2">
                <button type="button" className="btn px-2 py-1 text-[10px]" onClick={() => { for (const [key, value] of Object.entries(preset.settings)) registry.setSetting(selected, key, value); setError(""); }}>{preset.label}</button>
                {preset.description && <span className="min-w-0 flex-1 text-[9px] leading-5 text-[#90969E]">{preset.description}</span>}
              </div>)}
            </div> : null}
            {current.manifest.settings!.map(({ key, label, type, placeholder, persist, tool, help }) => type === "tool-path" && tool
              ? <ToolPathField key={key} tool={tool} label={label} placeholder={placeholder} help={help} />
              : <label key={key} className="block text-[10px]">{label}<input aria-label={label} type={type} className="input mt-1 w-full text-[11px]" placeholder={placeholder} value={registry.getSetting(selected, key)} onChange={(e) => registry.setSetting(selected, key, e.target.value, persist)} /></label>)}
            {provider?.test && <ProviderConnectionTest key={selected + ":" + provider.id} provider={provider} active={dialog === "plugins" && selected === current.manifest.id} endpoint={registry.getSetting(selected, "endpoint")} model={registry.getSetting(selected, "model")} apiKey={registry.getSetting(selected, "apiKey")} />}
            <p className="text-[9px] leading-5 text-[#90969E]">{current.manifest.settingsHelp}</p>
          </div>}
          {registry.errors.map((issue) => <p key={issue} role="alert" className="mt-2 text-[#9A702C]">{issue}</p>)}
          {error && <p role="alert" className="mt-4 rounded bg-[#FFF5E7] p-2 text-[#9A702C]">{error}</p>}
        </div>
      </div>
      <div className="flex justify-end border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5"><button className="btn px-3 py-1" onClick={() => { addToast({ title: "插件已随应用安装", detail: "外部插件安装和插件市场尚未实现。" }); }}>安装说明</button></div>
    </Modal>
  );
}
