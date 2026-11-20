import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Play, ShieldCheck, Square, Usb } from "lucide-react";
import type { FirmwareDevSessionView } from "../../shared/firmwareDev";
import type { TransportPort } from "../plugins/api";
import { isDesktop } from "../lib/desktop";
import { useDisk } from "../store/disk";
import { useStudio } from "../store/studio";

// Slim start/stop block for the automatic firmware task.
//
// It shows only what decides the next action: the trusted session (project, environment, board),
// the real stage and result of each host step, and one actionable error. It never renders tool logs
// and never re-implements the firmware verification panel.

const STAGE_LABEL: Record<FirmwareDevSessionView["stage"], string> = {
  ready: "已开始 · 待构建",
  built: "已构建",
  simulated: "QEMU 已通过",
  previewed: "写入已核对",
  written: "已写入 app 槽",
  verified: "实机验证通过",
};

const short = (value: string | undefined, size = 12) => (!value ? "" : value.length > size ? value.slice(0, size) + "…" : value);
const oneLine = (value: string, size = 180) => value.replace(/\s+/g, " ").trim().slice(0, size);

export function FirmwareDevControl() {
  const root = useDisk((state) => state.root);
  const environments = useDisk((state) => state.environments);
  const environment = useDisk((state) => state.environment);
  const tasks = useDisk((state) => state.tasks);
  const loadEnvironments = useDisk((state) => state.loadEnvironments);
  const agentRunning = useStudio((state) => state.agentRunning);
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [port, setPort] = useState("");
  const [session, setSession] = useState<FirmwareDevSessionView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const api = typeof window === "undefined" ? undefined : window.aether?.firmwareDev;
  const appOnly = session?.appOnlyWriteAuthorized ?? false;
  const sourceEdit = session?.sourceEditAuthorized ?? false;
  const active = !!session?.active;
  const realTaskRunning = tasks.some((task) => task.status === "running");
  const blocked = busy || agentRunning || realTaskRunning;

  const refreshPorts = useCallback(async () => {
    const serial = window.aether?.serial;
    if (!serial) return;
    const items = await serial.list().catch(() => [] as TransportPort[]);
    setPorts(items);
    setPort((current) => (items.some((item) => item.path === current) ? current : (items[0]?.path ?? "")));
  }, []);

  useEffect(() => {
    if (!isDesktop() || !api) return;
    let current = true;
    void api.status().then((value) => { if (current) setSession(value); }, () => {});
    const off = api.onChanged((value) => { if (current) setSession(value); });
    void loadEnvironments("platformio.build").catch(() => {});
    void refreshPorts();
    return () => { current = false; off(); };
  }, [api, loadEnvironments, refreshPorts]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(oneLine(reason instanceof Error ? reason.message : String(reason))); }
    finally { setBusy(false); }
  };

  const start = () => run(async () => {
    if (!api) throw new Error("自动固件任务需要 Electron 桌面端");
    if (!root) throw new Error("请先打开 ESP32-C3 验证工程目录");
    if (!environment.trim()) throw new Error("请先选择 PlatformIO 环境");
    if (!port.trim()) throw new Error("请先选择专用测试板串口");
    // The user's confirmation of this run's two write scopes is what the host records.
    const started = await api.start({ environment, port: port.trim(), appOnlyWrite: true, sourceEdit: true });
    setSession(started);
    // The built-in Agent owns every later action; nothing is done by this panel or by the user.
    useStudio.getState().setAgent("firmware-dev");
    await useStudio.getState().runAgent("执行当前工程的自动固件开发任务。按真实步骤依次调用工具，不要跳过任何一步；失败或取消时如实说明首个错误与阶段。");
  });

  const stop = () => run(async () => {
    if (agentRunning) useStudio.getState().cancelAgent();
    if (api) setSession(await api.stop());
  });

  const progress = session?.stability
    ? session.stability.counts.length + " 次 COUNT · 观察 " + Math.round(session.stability.observedMs / 1000) + " 秒"
    : "";

  if (!isDesktop()) {
    return <p className="mt-2 rounded bg-[#FFF5E7] p-2 text-[9.5px] text-[#9A702C]">自动固件任务需要 Electron 桌面端；这里不会模拟任何步骤。</p>;
  }

  return <div data-firmware-dev="1" className="mt-2 rounded-[8px] border border-[#E4E8EC] bg-white p-2">
    <div className="flex items-center gap-1.5">
      <ShieldCheck size={10.5} className="text-[#4E7CA6]" />
      <span className="text-[10px] font-semibold text-[#3A4048]">自动固件任务</span>
      <span className={active ? "ml-auto rounded-[3px] bg-[#EDF5FF] px-1.5 text-[7.5px] font-semibold text-[#2F6BAE]" : "ml-auto text-[8px] text-[#9AA0A8]"}>
        {active ? STAGE_LABEL[session!.stage] : "未开始"}
      </span>
    </div>

    {!active && (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px] text-[#6D747C]">
        <select aria-label="自动任务环境" className="rounded border border-[#E4E7EB] bg-white px-1.5 py-0.5" disabled={blocked} value={environment} onChange={(event) => useDisk.getState().setEnvironment(event.target.value)}>
          {!environments.length && <option value="">未发现环境</option>}
          {environments.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
        <select aria-label="自动任务端口" className="rounded border border-[#E4E7EB] bg-white px-1.5 py-0.5" disabled={blocked} value={port} onChange={(event) => setPort(event.target.value)}>
          {!ports.length && <option value="">未枚举到端口</option>}
          {ports.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
        </select>
        <button className="btn btn-primary ml-auto px-2 py-1 text-[9.5px]" disabled={blocked || !root || !environment || !port} onClick={() => void start()}>
          <Play size={9} /> 开始（只写活动 app 槽）
        </button>
      </div>
    )}

    {active && (
      <div className="mt-1.5 text-[9px] leading-[1.6] text-[#5A616A]">
        <div className="truncate">{session!.root}</div>
        <div className="text-[8.5px] text-[#90969E]">{session!.environment} · {session!.port}{session!.device ? " · " + session!.device.chipName + " rev " + (session!.device.revision || "?") : ""} · 只写 app 槽 / 仅改既有源码</div>
        {session!.steps.slice(-1).map((step) => (
          <div key={step.name + step.startedAt} className="mt-1 flex items-center gap-1">
            <span className={step.status === "failed" ? "h-[4px] w-[4px] rounded-full bg-[#D15345]" : step.status === "cancelled" ? "h-[4px] w-[4px] rounded-full bg-[#C08A2E]" : step.status === "running" ? "h-[4px] w-[4px] rounded-full bg-[#007AFF]" : "h-[4px] w-[4px] rounded-full bg-[#2B9661]"} />
            <span className="font-medium text-[#3A4048]">{step.name}</span>
            <span className="truncate text-[#90969E]">{step.detail}</span>
          </div>
        ))}
        {session!.build && <div className="mt-1 font-mono text-[8px] text-[#8A9098]">app {short(session!.build.appSha256)} · {session!.build.firmwareBytes} B</div>}
        {session!.qemu && <div className="font-mono text-[8px] text-[#8A9098]">QEMU {session!.qemu.boots} 次 · fw {session!.qemu.fwid}</div>}
        {session!.preview && <div className="font-mono text-[8px] text-[#8A9098]">槽 {session!.preview.slot.label} · 擦除 {session!.preview.erase.size} B</div>}
        {session!.write && <div className="font-mono text-[8px] text-[#8A9098]">写入 {session!.write.status} · {short(session!.write.taskId, 8)}</div>}
        {session!.challenge && <div className="font-mono text-[8px] text-[#8A9098]">实机挑战 {session!.challenge.passed && session!.challenge.bound ? "通过" : "未通过"} · 会话 {session!.challenge.sessionId}</div>}
        {progress && <div className="font-mono text-[8px] text-[#8A9098]">{progress}{session!.stability?.restartDetected ? " · 检测到复位/看门狗" : ""}</div>}
        <div className="mt-1.5 flex gap-1.5">
          <button className="btn px-2 py-1 text-[9.5px]" disabled={busy && !agentRunning} onClick={() => void stop()}>
            <Square size={9} /> 停止
          </button>
          {appOnly && sourceEdit && <span className="ml-auto flex items-center gap-1 text-[8px] text-[#2B7F58]"><Usb size={8.5} /> 仅活动 app 槽 · 仅既有源码</span>}
        </div>
      </div>
    )}

    {(error || session?.error) && (
      <p role="alert" className="mt-1.5 flex items-start gap-1 rounded bg-[#FFF5E7] p-1.5 text-[9px] text-[#9A702C]">
        <CircleAlert size={9} className="mt-[1px]" /> {oneLine(error || session?.error || "", 200)}
      </p>
    )}
  </div>;
}
