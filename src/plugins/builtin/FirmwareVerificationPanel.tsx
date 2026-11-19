import { useCallback, useEffect, useMemo, useState } from "react";
import { Cpu, FlaskConical, Play, RefreshCw, ShieldCheck, Square, Usb } from "lucide-react";
import type { ToolStatus } from "../../../shared/tools";
import type { VerificationStatusView, VerifiedDeployView } from "../../../shared/firmwareVerification";
import type { TransportPort } from "../api";
import { isDesktop } from "../../lib/desktop";
import { useDisk, waitForTask } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { useTransport } from "../../store/transport";

const hex = (value: number) => "0x" + value.toString(16).toUpperCase();
const short = (value: string, size = 12) => (value.length > size ? value.slice(0, size) + "…" : value);
const oneLine = (value: string, size = 180) => value.replace(/\s+/g, " ").trim().slice(0, size);
const norm = (value: string) => value.trim().toUpperCase();

export function FirmwareVerificationPanel() {
  const root = useDisk((state) => state.root);
  const environments = useDisk((state) => state.environments);
  const environment = useDisk((state) => state.environment);
  const tasks = useDisk((state) => state.tasks);
  const starting = useDisk((state) => state.starting);
  const loadEnvironments = useDisk((state) => state.loadEnvironments);
  const setEnvironment = useDisk((state) => state.setEnvironment);
  const [status, setStatus] = useState<VerificationStatusView | null>(null);
  const [tool, setTool] = useState<ToolStatus | null>(null);
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [port, setPort] = useState("");
  const [transport, setTransport] = useState<"usb-serial-jtag" | "uart0">("usb-serial-jtag");
  const [issued, setIssued] = useState<VerifiedDeployView | null>(null);
  const [deployed, setDeployed] = useState<VerifiedDeployView | null>(null);
  const [deployTaskId, setDeployTaskId] = useState("");
  const [commitFailed, setCommitFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(() => Date.now());

  const api = typeof window === "undefined" ? undefined : window.aether?.firmwareVerification;
  const evidence = status?.evidence ?? null;
  const hardware = status?.hardware ?? null;

  const buildTask = useMemo(() => tasks
    .filter((task) => task.provider === "platformio.build" && task.root === root && (!environment || task.environment === environment))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1), [tasks, root, environment]);
  // After the panel is unmounted (for example, opening Build Tasks and coming back) the task store
  // still knows the last verified write. Accept only an app-only upload with a valid plan digest, so
  // a generic full-plan upload can never be shown as this verified deploy.
  const verifiedUpload = useMemo(() => tasks
    .filter((task) => task.provider === "esp.upload" && task.status === "succeeded" && task.root === root && task.environment === environment && norm(String(task.options?.port ?? "")) === norm(port))
    .filter((task) => {
      const metadata = task.metadata as { appOnly?: { mode?: string }; simulation?: { appSha256?: string; planSha256?: string } } | undefined;
      return metadata?.appOnly?.mode === "app-only" && /^[0-9a-f]{64}$/i.test(metadata?.simulation?.planSha256 ?? "") && /^[0-9a-f]{64}$/i.test(metadata?.simulation?.appSha256 ?? "");
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1), [tasks, root, environment, port]);
  const deployTask = useMemo(() => {
    const byId = deployTaskId ? tasks.find((task) => task.id === deployTaskId) : undefined;
    if (byId) return byId;
    // A pending preview or a refused commit is not "the last verified write"; do not resurrect it.
    if (status?.preview || commitFailed) return undefined;
    return verifiedUpload;
  }, [deployTaskId, tasks, status?.preview, commitFailed, verifiedUpload]);

  const refreshPorts = useCallback(() => {
    const serial = window.aether?.serial;
    if (!serial) return;
    setListing(true);
    void serial.list().then((items) => {
      setPorts(items);
      setPort((current) => (items.some((item) => item.path === current) ? current : (items[0]?.path ?? "")));
    }, (reason) => setError(oneLine(String(reason)))).finally(() => setListing(false));
  }, []);

  useEffect(() => {
    if (!isDesktop() || !api) return;
    let current = true;
    void api.status().then((value) => { if (current) setStatus(value); }, () => {});
    const off = api.onChanged((value) => { if (current) setStatus(value); });
    void window.aether?.tools.status("qemu-esp32c3").then((value) => { if (current) setTool(value); }, () => {});
    void loadEnvironments("platformio.build").catch(() => {});
    refreshPorts();
    return () => { current = false; off(); };
  }, [api, loadEnvironments, refreshPorts]);

  useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => setTick(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [issued]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(oneLine(reason instanceof Error ? reason.message : String(reason))); }
    finally { setBusy(false); }
  };

  const dropPreview = useCallback(() => {
    setIssued(null);
    setDeployed(null);
    setDeployTaskId("");
    setCommitFailed(false);
    void api?.disarm().catch(() => {});
  }, [api]);

  const saveAndBuild = () => run(async () => {
    if (!environment.trim()) throw new Error("请先选择 PlatformIO 环境");
    dropPreview();
    setEnvironment(environment);
    const task = await useDisk.getState().build("platformio.build", { environment });
    const settled = await waitForTask(task.id);
    if (settled.status !== "succeeded") throw new Error("构建未通过：" + oneLine(settled.error || "见 Build Tasks 日志", 120));
  });

  const verify = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    dropPreview();
    await api.startSimulation({ environment, boots: 2 });
  });

  const preview = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    if (!port.trim()) throw new Error("请先选择实机串口");
    dropPreview();
    const value = await api.previewDeploy({ environment, port: port.trim() });
    setIssued(value);
  });

  const deploy = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    if (!previewValid || !hostPreview) throw new Error("写入预览已失效，请重新核对");
    const target = hostPreview;
    setDeployed(target);
    setDeployTaskId("");
    setCommitFailed(false);
    try {
      const result = await api.commitDeploy({ token: target.token, environment, port: port.trim() });
      setDeployTaskId(result.taskId);
      setIssued(null);
    } catch (reason) {
      // The host refused before a process existed; no write happened for this target.
      setDeployed(null);
      setCommitFailed(true);
      throw reason;
    }
  });

  const challenge = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    await api.runDevice({ port: port.trim(), transport });
  });

  const taskRunning = starting || tasks.some((task) => task.status === "running");
  const portBusy = busy || taskRunning;
  const hostPreview = status?.preview ?? null;
  const evidenceMatches = !!evidence && evidence.passed && evidence.root === root && evidence.environment === environment;
  const simulated = evidenceMatches;
  const previewValid = !!issued && !!hostPreview && hostPreview.token === issued.token
    && hostPreview.root === root && hostPreview.environment === environment
    && norm(hostPreview.port) === norm(port) && hostPreview.evidenceId === evidence?.id
    && (!evidence || hostPreview.appSha256 === evidence.appSha256)
    && Date.parse(hostPreview.expiresAt) > tick;
  const shownPreview = previewValid ? hostPreview : null;
  const deployMatches = !!deployTask && deployTask.root === root && deployTask.environment === environment
    && norm(String(deployTask.options?.port ?? "")) === norm(port);
  const deploySimulation = (deployTask?.metadata as { simulation?: { appSha256?: string; planSha256?: string } } | undefined)?.simulation;
  const uploadSucceeded = !!deployTask && deployTask.status === "succeeded" && deployMatches;
  const appMatches = uploadSucceeded && !!evidence && evidenceMatches
    && !!deploySimulation?.appSha256 && deploySimulation.appSha256.toLowerCase() === evidence.appSha256;
  const hardwareMatches = !!hardware && hardware.root === root && norm(hardware.port) === norm(port) && hardware.environment === environment
    && !!deploySimulation?.planSha256 && norm(String(hardware.planSha256 ?? "")) === norm(deploySimulation.planSha256);
  const hardwarePassed = hardwareMatches && !!hardware?.passed;
  const writing = !!deployTask && deployTask.status === "running" && deployMatches;
  const buildOk = buildTask?.status === "succeeded";
  const deployedMatches = !!deployed && deployed.root === root && deployed.environment === environment && norm(deployed.port) === norm(port);
  const displayTarget = shownPreview ?? (deployedMatches ? deployed : null);
  const fallbackTask = !!deployTask && deployTask.id !== deployTaskId;
  const fallbackAppOnly = (deployTask?.metadata as { appOnly?: { target?: { label: string; offset: number; size: number; erase: { offset: number; size: number } } } } | undefined)?.appOnly;
  const fallbackTarget = fallbackTask && fallbackAppOnly?.target ? fallbackAppOnly.target : null;

  const writeResult = !deployTask ? "" : !deployMatches ? "最近一次写入属于其他端口或环境。"
    : writing ? "正在写入…"
    : deployTask.status === "succeeded" ? ((fallbackTask ? "最近一次验证写入：" : "写入完成：") + (appMatches ? "app SHA 与 QEMU 记录一致。" : "没有同镜像的验证绑定，不能作为本次验证部署。"))
    : deployTask.status === "cancelled" ? "写入已取消；若已开始擦写，设备上的 app 可能不完整。"
    : "写入任务失败，可能已发生部分写入；请核对设备后重新验证。";
  const hardwareResult = !hardware ? "" : !hardwareMatches ? "该记录不属于本次写入。"
    : hardwarePassed ? "实机挑战通过：新开会话，回包与本次部署绑定。" : "实机挑战未通过：" + oneLine(hardware.reason || "设备未返回匹配响应", 140);

  if (!isDesktop()) {
    return <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
      <h1 className="text-base font-semibold">Firmware Verification（固件验证）</h1>
      <p className="mt-2 rounded bg-[#FFF5E7] p-2 text-[#9A702C]">真实 QEMU 与实机串口挑战需要 Electron 桌面端。</p>
    </div>;
  }

  return <div data-firmware-verification="1" className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="flex items-center gap-2 text-base font-semibold"><FlaskConical size={15} /> Firmware Verification（固件验证）</h1>
    <p className="mt-1 leading-5 text-[#90969E]">ESP32-C3 示例：真实构建 → 两次 QEMU 随机挑战 → 核对并只写活动 OTA 槽中的同一 app → 新串口会话实机挑战。QEMU 只模拟 SoC 与 UART。</p>

    <section className="mt-4 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>1 · 工程与环境</strong>
        <span className="text-[10px] text-[#90969E]">{root || "未打开工程目录"}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">环境
          <select aria-label="验证环境" className="input h-[26px] px-2" disabled={portBusy} value={environment} onChange={(event) => { dropPreview(); setEnvironment(event.target.value); }}>
            {!environments.length && <option value="">未发现环境</option>}
            {environments.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <button className="btn px-2 py-1 text-[10px]" disabled={portBusy || !root || !environment} onClick={() => void saveAndBuild()}>保存并构建</button>
        {status?.running
          ? <button className="btn px-2 py-1 text-[10px]" onClick={() => void api?.cancel()}><Square size={10} /> 取消验证</button>
          : <button className="btn btn-primary px-2 py-1 text-[10px]" disabled={portBusy || !root || !environment || !tool?.available || !buildOk} onClick={() => void verify()}><Play size={10} /> QEMU 验证</button>}
        <span className="text-[10px] text-[#90969E]">{simulated ? "QEMU 已通过" : "QEMU 未通过"}</span>
      </div>
      {!tool?.available && <p className="mt-1 text-[10px] text-[#A8741F]">未找到 Espressif QEMU；请在插件设置中指定 qemu-system-riscv32。</p>}
      {tool?.available && !buildOk && <p className="mt-1 text-[10px] text-[#90969E]">先构建当前环境，再运行 QEMU 验证。</p>}
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>2 · 设备与写入</strong>
        <span className="text-[10px] text-[#90969E]">只写活动 OTA 槽中的单一 app；不写 bootloader、分区表、otadata、phy_init、model 或 ota_0。</span>
        <button className="btn ml-auto px-2 py-1 text-[10px]" disabled={listing} onClick={refreshPorts}><RefreshCw size={10} /> 刷新端口</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">端口
          <select aria-label="实机端口" className="input h-[26px] px-2" disabled={portBusy} value={port} onChange={(event) => { dropPreview(); setPort(event.target.value); }}>
            {!ports.length && <option value="">未枚举到端口</option>}
            {ports.map((item) => <option key={item.path} value={item.path}>{item.path} · {item.label}</option>)}
          </select>
        </label>
        <button className="btn px-2 py-1 text-[10px]" disabled={portBusy || !simulated || !port} onClick={() => void preview()}><ShieldCheck size={10} /> 核对写入</button>
        <button className="btn btn-primary px-2 py-1 text-[10px]" disabled={portBusy || !previewValid || writing} onClick={() => void deploy()}><Usb size={10} /> {writing ? "正在写入…" : "烧录已验证 app"}</button>
        {shownPreview && <button className="btn px-2 py-1 text-[10px]" disabled={portBusy} onClick={dropPreview}>取消预览</button>}
      </div>
      {displayTarget && <div className="mt-2 rounded bg-[#F8F9FB] p-2 text-[10px] leading-5">
        <div>设备 {displayTarget.device.chipName} rev {displayTarget.device.revision || "?"} · {displayTarget.device.flashSize ? (displayTarget.device.flashSize / 1048576) + " MB" : "flash 未识别"} · {displayTarget.port}</div>
        <div>目标槽 {displayTarget.slot.label} @ {hex(displayTarget.slot.offset)}</div>
        <div>写入/擦除 {hex(displayTarget.erase.offset)}–{hex(displayTarget.erase.offset + displayTarget.erase.size - 1)}（{displayTarget.erase.size} 字节）</div>
        <div>app {displayTarget.app.size} 字节 · SHA-256 {short(displayTarget.appSha256, 16)}</div>
        <div className="text-[#90969E]">{shownPreview ? "预览 " + new Date(shownPreview.expiresAt).toLocaleTimeString("en-GB", { hour12: false }) + " 前有效；写入前宿主会再次核对设备、活动槽、构建记录与产物。" : "本次写入目标；写入结果见下方。"}</div>
      </div>}
      {writeResult && <p role="status" className={"mt-2 text-[10px] " + (uploadSucceeded && appMatches ? "text-[#2F7B4F]" : "text-[#A8741F]")}>{writeResult}</p>}
      {!displayTarget && fallbackTarget && <p className="mt-1 text-[10px] text-[#59616A]">最近一次写入目标槽 {fallbackTarget.label} @ {hex(fallbackTarget.offset)} · 写入/擦除 {hex(fallbackTarget.erase.offset)}–{hex(fallbackTarget.erase.offset + fallbackTarget.erase.size - 1)} · app {fallbackTarget.size} 字节{deploySimulation?.appSha256 ? " · SHA-256 " + short(deploySimulation.appSha256, 16) : ""}</p>}
      {deployTask && <button className="mt-1 text-[10px] text-[#2F7FD8]" onClick={() => useStudio.getState().setTab("panel:build.tasks")}>查看任务日志</button>}
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>3 · 独立实机挑战</strong>
        <span className="text-[10px] text-[#90969E]">写入成功后新开串口会话，由宿主生成新挑战；回包必须绑定本次镜像与部署记录。</span>
        <button className="btn btn-primary ml-auto px-2 py-1 text-[10px]" disabled={portBusy || !port || !appMatches} onClick={() => void challenge()}><Cpu size={10} /> 实机挑战</button>
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-[10px]">通道
        <select aria-label="实机挑战通道" className="input h-[24px] px-2" disabled={portBusy} value={transport} onChange={(event) => setTransport(event.target.value as "usb-serial-jtag" | "uart0")}>
          <option value="usb-serial-jtag">USB-Serial/JTAG（原生 USB）</option>
          <option value="uart0">UART0（经 USB-UART 桥）</option>
        </select>
        <button className="btn ml-1 px-2 py-0.5 text-[10px]" onClick={refreshPorts} disabled={listing}><RefreshCw size={10} /> 重新枚举</button>
      </label>
      {hardwareResult && <p role="status" className={"mt-2 text-[10px] " + (hardwarePassed ? "text-[#2F7B4F]" : "text-[#A8741F]")}>{hardwareResult}</p>}
    </section>

    {error && <p role="alert" className="mt-3 rounded bg-[#FFF5E7] p-2 text-[#9A702C]">{error}</p>}
    {!error && status?.error && <p role="status" className="mt-3 text-[10px] text-[#A8741F]">{oneLine(status.error, 200)}</p>}
  </div>;
}
