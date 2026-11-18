import { isDesktop } from "../lib/desktop";
import { validProjectPath } from "../../shared/projectFormat";
import { usePlugins } from "../plugins/usePlugins";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowUpToLine,
  Check,
  CheckCircle2,
  ChevronRight,
  CircuitBoard,
  Cloud,
  Cpu,
  Droplets,
  FileCode2,
  FlaskConical,
  FolderPlus,
  Gauge,
  LoaderCircle,
  Monitor,
  Plus,
  Radio,
  RefreshCw,
  Square,
  Thermometer,
  Usb,
  Wind,
  Wifi,
  X,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { useDisk } from "../store/disk";
import { useTransport } from "../store/transport";
import type { TransportPort } from "../plugins/api";
import type { EspPreflightResult, EspUploadCheck } from "../../shared/esp";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

export function Modal({
  open,
  onOpenChange,
  children,
  width = 560,
  onOpenAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  width?: number;
  onOpenAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content onOpenAutoFocus={onOpenAutoFocus} className="dialog" style={{ width, maxWidth: "calc(100vw - 64px)" }}>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Dialog.Close asChild>
      <button type="button" className="flex h-[24px] w-[24px] items-center justify-center rounded-[5px] text-[#8B9199] hover:bg-[#F0F2F4] hover:text-[#4D545C]" aria-label="Close dialog" onClick={onClick}>
        <X size={13} />
      </button>
    </Dialog.Close>
  );
}

function BoardGlyph({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="32" viewBox="0 0 24 32" fill="none">
      <rect x="4" y="1" width="16" height="30" rx="2.5" fill={active ? "#3C4653" : "#A7AFB8"} />
      <rect x="7.5" y="5" width="9" height="8" rx="1" fill={active ? "#C6D1DD" : "#DDE3E9"} />
      <rect x="9.5" y="26" width="5" height="2.8" rx="1" fill={active ? "#9BA8B5" : "#CDD4DB"} />
      {[6, 10, 14, 18, 22].map((y) => (
        <g key={y}>
          <rect x="1.4" y={y} width="3" height="2" rx="0.4" fill={active ? "#D8B96F" : "#C5CBD2"} />
          <rect x="19.6" y={y} width="3" height="2" rx="0.4" fill={active ? "#D8B96F" : "#C5CBD2"} />
        </g>
      ))}
    </svg>
  );
}

export function NewProjectDialog() {
  const { dialog, setDialog, createProject } = useStudio();
  const [name, setName] = useState("Greenhouse Climate Node");
  const registry = usePlugins();
  const boards = registry.all("boards");
  const templates = registry.all("templates");
  const [board, setBoard] = useState("");
  const [template, setTemplate] = useState("");

  useEffect(() => {
    if (dialog === "new-project") {
      setName("Greenhouse Climate Node");
      setBoard(boards[0]?.id ?? "");
      setTemplate((isDesktop() ? templates.find((item) => item.id === "ESP32-S3 C++")?.id : undefined) ?? templates[0]?.id ?? "");
    }
  }, [dialog]);

  return (
    <Modal open={dialog === "new-project"} onOpenChange={(open) => !open && setDialog(null)} width={566}>
      <Dialog.Title className="sr-only">Create project</Dialog.Title>
      <Dialog.Description className="sr-only">Create a new hardware workspace in Aether Studio.</Dialog.Description>
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-[#EEF4FB] text-[#3F6FA5] shadow-[inset_0_0_0_0.5px_rgba(20,24,33,0.06)]">
          <FolderPlus size={17} strokeWidth={1.7} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-[-0.012em] text-[#23272C]">Create a project</div>
          <div className="mt-0.5 text-[10px] text-[#90969E]">A new workspace with a virtual board, circuit and firmware.</div>
        </div>
        <CloseButton onClick={() => setDialog(null)} />
      </div>

      <div className="border-t border-[#ECEEF1] px-5 py-4">
        <label className="label-caps mb-1.5 block text-[8.5px]">Project name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input h-[32px] w-full text-[11.5px]"
          placeholder="Untitled workspace"
        />

        <div className="mt-4 flex items-center justify-between">
          <span className="label-caps text-[8.5px]">Target board</span>
          <button className="flex items-center gap-1 text-[9px] text-[#7D848C] hover:text-[#007AFF]" onClick={() => setDialog("plugins")}>
            Manage boards <ChevronRight size={10} />
          </button>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          {boards.map((definition) => {
            const label = definition.name;
            const meta = definition.description;
            const spec = "来自已启用插件";
            const value = definition.id;
            const selected = board === value;
            return (
              <button
                key={label}
                onClick={() => setBoard(value)}
                className={cn(
                  "relative flex flex-col items-start rounded-[7px] border p-2.5 text-left transition-all",
                  selected ? "border-[#9CC7F5] bg-[#F5FAFF] shadow-[0_0_0_2px_rgba(0,122,255,0.06)]" : "border-[#E5E8EC] bg-white hover:border-[#D4D9DF]",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <BoardGlyph active={selected} />
                  <span className={cn("text-[9.5px] font-[560]", selected ? "text-[#185C9E]" : "text-[#454B53]")}>{label}</span>
                </div>
                <span className="mt-1.5 text-[8px] leading-[1.45] text-[#9298A0]">{meta}</span>
                <span className="text-[7.5px] text-[#B0B4BB]">{spec}</span>
                {selected && (
                  <span className="absolute right-2 top-2 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-[#007AFF]">
                    <Check size={8} strokeWidth={3} className="text-white" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          <span className="label-caps mb-1.5 block text-[8.5px]">Start from</span>
          <div className="grid grid-cols-2 gap-1.5">
            {templates.filter((t) => t.board === board).map((definition) => {
              const label = definition.id;
              const meta = definition.description;
              const Icon = CircuitBoard;
              const selected = template === label;
              return (
                <button
                  key={label as string}
                  onClick={() => setTemplate(label as string)}
                  className={cn(
                    "flex items-center gap-2 rounded-[6px] border px-2.5 py-2 text-left transition-colors",
                    selected ? "border-[#B8D7F8] bg-[#F5FAFF]" : "border-[#E7EAEE] bg-white hover:border-[#D5DAE0]",
                  )}
                >
                  <span className={cn("flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[5px]", selected ? "bg-white text-[#2F7DCE]" : "bg-[#F4F6F8] text-[#8A929A]")}>
                    <Icon size={11.5} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[9.5px] font-[540] text-[#3E444B]">{label as string}</span>
                    <span className="mt-[1px] block truncate text-[8px] text-[#9AA0A8]">{meta as string}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[8.5px] text-[#9AA0A8]"><CircuitBoard size={10} /> Local workspace · 创建后保存</span>
        <div className="flex items-center gap-1.5">
          <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => setDialog(null)}>Cancel</button>
          <button
            className="btn btn-primary h-[27px] px-3 text-[10px]"
            disabled={!name.trim() || !boards.some((b) => b.id === board) || !templates.some((t) => t.id === template)}
            onClick={() => createProject({ name: name.trim(), board, template })}
          >
            Create Project
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DeployDialog() {
  const { dialog, setDialog, capabilities, getProjectContext, setTab } = useStudio();
  const registry = usePlugins();
  const disk = useDisk();
  const io = useTransport();
  const revision = registry.getRevision();
  const providers = registry.all("deployments").filter((provider) => provider.toolchain === capabilities.toolchain);
  const [selected, setSelected] = useState("");
  const [address, setAddress] = useState("");
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portsError, setPortsError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [monitorBaud, setMonitorBaud] = useState("115200");
  const provider = providers.find((item) => item.id === selected);
  const monitor = provider?.monitor;
  const portSource = provider?.ports;
  const task = taskId ? disk.tasks.find((item) => item.id === taskId) : undefined;
  const taskPort = task?.options?.port ?? "";
  const uploadRunning = task?.status === "running";
  const busy = submitting || !!uploadRunning || disk.starting || ["connecting", "disconnecting"].includes(io.status);
  const preflight = disk.espPreflight;
  const metadata = task?.metadata as { writeCheck?: EspUploadCheck; journal?: { directory: string; totalBytes: number; ranges: unknown[] } } | undefined;
  const writeCheck = metadata?.writeCheck;
  const journal = metadata?.journal;
  useEffect(() => {
    if (dialog !== "deploy") return;
    const available = registry.all("deployments").filter((item) => item.toolchain === capabilities.toolchain);
    const first = available[0];
    setSelected(first?.id ?? "");
    setError(""); setSubmitting(false);
    setMonitorBaud(first?.monitor?.defaultBaudRate ?? "115200");
    // Results belong to the current disk project only; another project's upload must not look like this one.
    const latest = first ? disk.tasks.filter((item) => item.provider === first.id && item.root === disk.root).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) : undefined;
    setAddress(useTransport.getState().preferredAddress(first?.monitor?.transportId ?? "") || latest?.options?.port || "");
    setTaskId(latest?.id ?? "");
  }, [dialog, revision]);
  useEffect(() => {
    if (dialog !== "deploy" || !portSource) { setPorts([]); setPortsLoading(false); setPortsError(""); return; }
    let current = true;
    setPorts([]); setPortsLoading(true); setPortsError("");
    void portSource.list().then((items) => { if (current) setPorts(items); }, (reason) => { if (current) setPortsError(String(reason)); }).finally(() => { if (current) setPortsLoading(false); });
    return () => { current = false; };
  }, [dialog, provider?.id, revision, refreshToken]);
  const runDeploy = async () => {
    if (!provider || !address.trim() || busy || !isDesktop()) return;
    const port = address.trim();
    setSubmitting(true); setError(""); setTaskId(""); useDisk.setState({ espPreflight: null });
    try {
      const result = await provider.deploy(getProjectContext(), port);
      if (result?.taskId) { setTaskId(result.taskId); if (provider.monitor) io.setPreferredAddress(port, provider.monitor.transportId); }
      else { setDialog(null); setTab("panel:build.tasks"); }
    } catch (reason) {
      // A rejected hand-off (blocked preflight, failed build, busy port) never started a write.
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally { setSubmitting(false); }
  };
  const connectMonitor = async () => {
    const port = address.trim() || taskPort;
    if (!port || !monitor) return;
    setError("");
    try { await monitor.connect(port, monitorBaud); }
    catch (reason) { setError(String(reason)); return; }
    setDialog(null); setTab("serial");
  };
  const openLogs = () => { setDialog(null); setTab("panel:build.tasks"); };
  const statusText = !task ? "" : task.status === "running" ? "正在上传…" : task.status === "succeeded" ? "上传命令成功（退出码 0）" : task.status === "cancelled" ? "上传已取消" : "上传失败";
  const monitorPort = address.trim() || taskPort;
  const canConnect = !!monitor && !["connecting", "disconnecting"].includes(io.status) && (io.status !== "connected" || io.address === monitorPort);
  const monitorActive = io.status === "connected" && io.address === monitorPort;
  const lastLine = io.lines.filter((line) => line.level === "data").at(-1)?.text ?? "";
  return <Modal open={dialog === "deploy"} onOpenChange={(open) => !open && setDialog(null)} width={620}><form className="p-5" onSubmit={(event) => { event.preventDefault(); void runDeploy(); }}>
    <div className="flex justify-between"><Dialog.Title className="text-sm font-semibold">Deploy to device</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div>
    <Dialog.Description className="mt-3 text-[11px] leading-6 text-[#7D848C]">明确选择端口后调用已注册的部署插件。ESP 工程会先构建，再用只读的 esptool 读取芯片与板上分区，核对构建产物、写入地址与擦除对齐后才允许写入；核对未通过时不会启动上传。命令退出码为 0 仅代表命令成功。</Dialog.Description>
    {!providers.length ? <p className="mt-4 text-xs text-[#A8741F]">当前工具链没有已启用的部署插件。</p> : <>
      <div className="mt-3 rounded-md border border-[#E9EBEE] p-3">
        <div className="flex items-center justify-between text-[11px]"><span className="font-medium">已枚举端口（操作系统报告）</span><button type="button" className="btn px-2 py-1 text-[10px]" disabled={!portSource || portsLoading || busy} onClick={() => setRefreshToken((token) => token + 1)}>{portsLoading ? "正在枚举…" : "刷新端口"}</button></div>
        {!portSource ? <p className="mt-2 text-[10px] text-[#90969E]">该部署插件不提供端口枚举；可手动输入端口路径。</p> : portsError ? <p role="alert" className="mt-2 text-[10px] text-[#A8741F]">{portsError}</p> : portsLoading ? <p className="mt-2 text-[10px] text-[#90969E]">正在读取系统串口列表…</p> : ports.length ? <ul className="mt-2 space-y-1">{ports.map((item) => <li key={item.path}><button type="button" aria-pressed={address === item.path} className={cn("w-full rounded border px-2 py-1 text-left text-[10px]", address === item.path ? "border-[#007AFF] bg-[#F2F8FF]" : "border-[#E9EBEE] hover:bg-[#F8F9FB]")} onClick={() => setAddress(item.path)}><span className="font-mono">{item.path}</span><span className="ml-2 text-[#59616A]">{item.label}</span>{item.detail && <span className="ml-2 text-[#90969E]">{item.detail}</span>}</button></li>)}</ul> : <p className="mt-2 text-[10px] text-[#90969E]">未枚举到端口。可手动输入路径。</p>}
        <p className="mt-2 text-[10px] leading-5 text-[#90969E]">列表只表示系统报告了端口和厂商描述，不能据此判断开发板型号或固件；不自动识别、不自动刷写未知设备。VID 303A 是 Espressif 原生 USB，其他 VID 通常是 USB-UART 桥。</p>
      </div>
      {providers.length > 1 && <label className="mt-3 block text-xs">Deployment plugin<select aria-label="Deployment plugin" className="input mt-1 w-full" disabled={busy} value={selected} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); setSelected(event.target.value); setTaskId(""); setError(""); setMonitorBaud(next?.monitor?.defaultBaudRate ?? "115200"); setAddress(next?.monitor ? io.preferredAddress(next.monitor.transportId) : ""); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <label className="mt-3 block text-xs">{provider?.endpointLabel}<input aria-label={provider?.endpointLabel} data-deploy-port className="input mt-1 w-full" list="deploy-ports" placeholder="COM3 / /dev/ttyUSB0 / /dev/cu.usbserial…" value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)} /><datalist id="deploy-ports">{ports.map((item) => <option key={item.path} value={item.path}>{item.label}</option>)}</datalist></label>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">必须明确填写或选择端口；留空不会开始上传。也可以手动输入未枚举到的端口路径。</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
        <button type="submit" className="btn btn-primary px-3 py-1.5 text-xs" disabled={busy || !address.trim() || !isDesktop()}>{submitting ? "正在核对…" : uploadRunning ? "正在上传…" : "开始构建并烧录"}</button>
        {uploadRunning && <button type="button" className="btn px-3 py-1.5" onClick={() => { if (task) void disk.cancel(task.id).catch((reason) => setError(String(reason))); }}>取消上传</button>}
        <button type="button" className="btn px-3 py-1.5" onClick={openLogs} disabled={!task}>查看完整日志</button>
      </div>
      {!isDesktop() && <p className="mt-2 text-[10px] leading-5 text-[#A8741F]">真实上传需要 Electron 桌面端和部署插件所需的工具；浏览器预览不会执行命令。</p>}
      {error && <p role="alert" className="mt-3 whitespace-pre-wrap text-xs text-[#A8741F]">{error}</p>}
      {preflight && preflight.supported && <section data-esp-preflight={preflight.ok ? "ok" : "blocked"} data-esp-preflight-port={preflight.port} className="mt-4 rounded-md border border-[#E9EBEE] p-3 text-[11px]">
        <div className="flex flex-wrap items-center gap-2"><strong>部署前核对</strong><span role="status" className={preflight.ok ? "text-[#3B9A68]" : "text-[#A8741F]"}>{preflight.ok ? "通过" : "已阻止写入"}</span><span className="text-[10px] text-[#90969E]">{preflight.port} · env {preflight.environment} · {new Date(preflight.checkedAt).toLocaleTimeString("en-GB", { hour12: false })}</span></div>
        <p className="mt-1 text-[10px] text-[#90969E]">设备 {preflight.chip.detectedName || "未识别"}（rev {preflight.chip.detectedRevision || "?"}）· 构建目标 {preflight.chip.expectedMcu || "未知"} · flash {preflight.flash.detected ? (preflight.flash.detected / 1048576) + " MB" : "?"} / 声明 {preflight.flash.declared ? (preflight.flash.declared / 1048576) + " MB" : "?"}</p>
        {preflight.segments.length > 0 && <div className="mt-2 overflow-x-auto"><table className="w-full border-collapse text-[10px]"><thead><tr className="text-left text-[#90969E]"><th className="border-b border-[#EEF0F3] py-1">段</th><th className="border-b border-[#EEF0F3]">地址</th><th className="border-b border-[#EEF0F3]">大小</th><th className="border-b border-[#EEF0F3]">SHA-256</th></tr></thead><tbody>{preflight.segments.map((segment) => <tr key={segment.name} className="font-mono"><td className="py-0.5">{segment.name}</td><td>0x{segment.offset.toString(16).toUpperCase()}</td><td>{segment.size}</td><td className="text-[9px]">{segment.sha256 ? segment.sha256.slice(0, 12) : "—"}</td></tr>)}</tbody></table></div>}
        {preflight.findings.length > 0 && <ul className="mt-2 space-y-1.5">{preflight.findings.map((finding) => <li key={finding.id} data-severity={finding.severity} className="leading-5"><span className={finding.severity === "block" ? "font-medium text-[#A8741F]" : finding.severity === "warn" ? "font-medium text-[#9A702C]" : "text-[#59616A]"}>{finding.severity === "block" ? "阻止" : finding.severity === "warn" ? "注意" : "信息"}：{finding.title}</span><span className="block text-[10px] text-[#7D848C]">{finding.detail}</span><span className="block text-[10px] text-[#59616A]">下一步：{finding.next}</span></li>)}</ul>}
      </section>}
      {task && <section data-deploy-task={task.id} data-deploy-status={task.status} data-deploy-port={taskPort} className="mt-4 rounded-md border border-[#E9EBEE] p-3 text-[11px]">
        <div className="flex flex-wrap items-center gap-2"><strong>上传任务</strong><span role="status">{statusText}</span><span className="text-[10px] text-[#90969E]">exit {task.exitCode ?? "—"}</span></div>
        <p className="mt-1 text-[10px] text-[#90969E]">端口 {taskPort || "—"} · {task.status === "running" ? "命令仍在运行" : "命令已结束"} · 任务 {task.id.slice(0, 8)}</p>
        {task.error && <p role="alert" className="mt-2 text-[#A8741F]">{task.error}</p>}
        {journal && <div data-write-journal="1" className="mt-2 rounded border border-[#E9EBEE] p-2 text-[10px] leading-5">
          <span className="font-medium text-[#3B9A68]">写前快照已校验：{journal.ranges.length} 个区块 / {journal.totalBytes} 字节</span>
          <span className="block break-all font-mono text-[9px] text-[#90969E]">{journal.directory}</span>
          <span className="block text-[#90969E]">写入会擦除这些 4KB 区块；快照在写入前读取两次并比对 SHA-256，快照失败时上传不会开始。</span>
        </div>}
        {writeCheck && <div data-write-check={writeCheck.ok ? "ok" : "mismatch"} className="mt-2 rounded border border-[#E9EBEE] p-2 text-[10px]">
          <span className={writeCheck.ok ? "font-medium text-[#3B9A68]" : "font-medium text-[#A8741F]"}>{writeCheck.ok ? "实际写入段与预检计划一致" : "实际写入段与预检计划不一致"}</span>
          {!writeCheck.ok && <ul className="mt-1 list-disc pl-4 text-[#A8741F]">{writeCheck.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
          <span className="mt-1 block text-[#90969E]">{writeCheck.evidence.writes.length} 段写入 · esptool 校验 {writeCheck.evidence.verifiedHashes} 段</span>
        </div>}
        <pre className="mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap rounded bg-[#F8F9FB] p-2 font-mono text-[10px] leading-5">{task.log.slice(-4000)}</pre>
        {task.status !== "running" && <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn px-3 py-1.5 text-[10px]" disabled={!canConnect} onClick={() => void connectMonitor()}>{monitorActive ? "打开" + (monitor?.label ?? "设备监视器") : task.status === "succeeded" ? "连接" + (monitor?.label ?? "设备监视器") : "连接" + (monitor?.label ?? "设备监视器") + "查看日志"}</button>
          {monitor && <label className="text-[10px] text-[#59616A]">波特率<input aria-label="监视波特率" type="number" min="1" step="1" className="input ml-1 w-[72px] px-1 py-0.5 text-[10px]" value={monitorBaud} onChange={(event) => setMonitorBaud(event.target.value)} /></label>}
          {["connected", "error"].includes(io.status) && io.address !== monitorPort && <button type="button" className="btn px-3 py-1.5 text-[10px]" onClick={() => void io.disconnect()}>断开当前连接</button>}
          {io.status === "error" && <button type="button" className="btn px-3 py-1.5 text-[10px]" disabled={!canConnect} onClick={() => void connectMonitor()}>重新连接（设备可能已重新枚举）</button>}
          {task.status !== "succeeded" && <button type="button" className="btn px-3 py-1.5 text-[10px]" disabled={busy || !isDesktop() || !address.trim()} onClick={() => void runDeploy()}>重试上传</button>}
        </div>}
        <div data-monitor-state={monitorActive ? "connected" : "idle"} className="mt-2 rounded bg-[#F8F9FB] p-2 text-[10px] leading-5">
          {monitorActive
            ? <>已接收真实串口字节 <strong>{io.receivedBytes}</strong> 个{io.receivedBytes === 0 ? "：尚未收到任何字节。上传退出码 0 不代表固件输出正常；原生 USB-CDC 设备可能需要复位或换用另一个 USB 口。" : "，最后一行：" + lastLine.slice(0, 120)}</>
            : "未连接监视器。上传退出码与串口输出是两件事：退出码只说明 esptool 命令结束，串口字节才说明固件真的在运行。"}
        </div>
        {task.status === "succeeded" && writeCheck && !writeCheck.ok && <p className="mt-2 text-[10px] leading-5 text-[#A8741F]">命令退出码为 0，但无法证明实际写入段与预检一致。请检查上方差异与完整日志，再决定是否复位设备。</p>}
        {task.status === "succeeded" && (!writeCheck || writeCheck.ok) && <p className="mt-2 text-[10px] leading-5 text-[#90969E]">上传命令已完成；设备可能已复位。连接同一端口可查看串口输出，若没有日志可手动复位设备。</p>}
        {task.status === "cancelled" && <p className="mt-2 text-[10px] leading-5 text-[#90969E]">任务已取消，端口交由操作系统回收；可重试上传或连接监视器。</p>}
      </section>}
    </>}
  </form></Modal>;
}


export function NewFileDialog() {
  const { dialog, setDialog, files, updateFile, openFile } = useStudio();
  const [name, setName] = useState("");
  useEffect(() => { if (dialog === "new-file") setName(""); }, [dialog]);
  const path = name.trim();
  const valid = validProjectPath(path) && !["aether.project.json", "circuit.json", "hardware/circuit.json"].includes(path) && !path.split("/").some((part) => [".git", ".pio", ".aether", "node_modules"].includes(part)) && !Object.hasOwn(files, path);
  return <Modal open={dialog === "new-file"} onOpenChange={(open) => !open && setDialog(null)} width={420}><form className="p-5" onSubmit={(event) => { event.preventDefault(); if (valid) { updateFile(path, ""); openFile(path); setDialog(null); } }}><div className="flex justify-between"><Dialog.Title className="text-sm font-semibold">New file</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div><Dialog.Description className="mt-3 text-[11px] text-[#90969E]">输入工程相对路径。保存工程时写入磁盘。</Dialog.Description><input aria-label="File path" autoFocus className="input my-3 w-full" value={name} onChange={(event) => setName(event.target.value)} placeholder="src/sensor.cpp" /><button type="submit" disabled={!valid} className="btn btn-primary px-3 py-1.5 text-xs">Create file</button>{path && !valid && <p role="alert" className="mt-2 text-[11px] text-[#A8741F]">路径无效、已存在，或属于宿主管理文件。</p>}</form></Modal>;
}
