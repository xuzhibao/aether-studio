import { useEffect, useMemo, useState } from "react";
import type { StudioPlugin } from "../api";
import { usePlugins } from "../usePlugins";
import { useStudio } from "../../store/studio";
import { useFlash } from "../../store/flash";
import { isDesktop } from "../../lib/desktop";
import type { FlashBackupMetadata, FlashCapabilities, FlashDeviceInfo, FlashProgress, FlashRestorePlan } from "../../../shared/flash";

const CHUNK_OPTIONS = [256, 512, 1024];
const BAUD_OPTIONS = [115200, 230400, 460800];
const RETRY_OPTIONS = [0, 1, 2, 3];

const hex = (n: number) => "0x" + n.toString(16);
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const clock = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

function ProgressBar({ progress }: { progress: FlashProgress | null }) {
  if (!progress) return null;
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.offset / progress.total) * 100)) : 0;
  return <div className="mt-2">
    <div className="flex items-center justify-between text-[10px] text-[#59616A]"><span role="status">{progress.message}</span><span className="tabular">{percent}%</span></div>
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#EDF0F3]"><div className="h-full rounded-full bg-[#007AFF] transition-all" style={{ width: `${percent}%` }} /></div>
    {progress.failedOffset !== undefined && <p className="mt-1 font-mono text-[10px] text-[#D34A3D]">失败偏移：{hex(progress.failedOffset)}</p>}
  </div>;
}

function Verification({ label, ok, blocked }: { label: string; ok: boolean; blocked?: boolean }) {
  return <div className="flex items-center gap-2 text-[10px]"><span className={ok ? "text-[#2B9661]" : "text-[#D34A3D]"}>{ok ? "✓" : "✗"}</span><span>{label}</span>{!ok && blocked && <span className="text-[#90969E]">（阻止写入）</span>}</div>;
}

export function FlashBackupPanel() {
  const flash = useFlash();
  const registry = usePlugins();
  const transports = registry.all("transports");
  const transport = useMemo(() => transports.find((item) => item.id === "native-serial"), [transports]);
  const snapshot = flash.snapshot;
  const status = snapshot?.status ?? "idle";
  const busy = status !== "idle" || flash.starting;
  const progress = snapshot?.progress ?? null;

  const [ports, setPorts] = useState<{ path: string; label: string; detail?: string }[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);
  const [port, setPort] = useState("");
  const [device, setDevice] = useState<FlashDeviceInfo | null>(null);
  const [capabilities, setCapabilities] = useState<FlashCapabilities | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [mode, setMode] = useState<"backup" | "restore">("backup");
  const [chunkKiB, setChunkKiB] = useState(512);
  const [baud, setBaud] = useState(230400);
  const [retries, setRetries] = useState(2);
  const [outputPath, setOutputPath] = useState("");
  const [backupFile, setBackupFile] = useState("");
  const [metadata, setMetadata] = useState<FlashBackupMetadata | null>(null);
  const [plan, setPlan] = useState<FlashRestorePlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");

  const options = { chunkSize: chunkKiB * 1024, baudRate: baud, retries };
  const run = (action: () => Promise<unknown>) => {
    setLocalError(""); setNotice("");
    void action().catch((error) => setLocalError(String((error as Error)?.message ?? error)));
  };

  useEffect(() => { void flash.init(); }, []);
  useEffect(() => { setPlan(snapshot?.plan ?? null); }, [snapshot?.plan]);

  const refreshPorts = () => {
    if (!transport) { setLocalError("桌面串口插件不可用；请先在 Plugins 启用“桌面串口”。"); return; }
    if (transport.unavailable) { setLocalError(transport.unavailable); return; }
    if (!transport.list) { setLocalError("当前串口插件不提供端口枚举，请手动输入端口。"); return; }
    setPortsLoading(true); setLocalError("");
    void transport.list().then((items) => { setPorts(items); if (!port && items[0]) setPort(items[0].path); }, (error) => setLocalError(String(error))).finally(() => setPortsLoading(false));
  };
  // Enumerate once when the panel opens; the user can refresh later.
  useEffect(() => { if (transport && !transport.unavailable) refreshPorts(); }, []);

  const detect = () => run(async () => {
    setDetecting(true);
    try {
      const info = await flash.describe(port);
      setDevice(info);
      const caps = await flash.capabilities();
      setCapabilities(caps);
      if (!outputPath) setOutputPath("");
      setNotice(`已读取 ${info.chip} · ${info.flashSizeLabel}；esptool ${caps.version}。${caps.writeFlash ? "" : " 当前 esptool 不支持写入，恢复会被拒绝。"}`);
    } finally { setDetecting(false); }
  });

  const chooseOutput = () => run(async () => {
    if (!device) throw new Error("请先读取设备信息，以便生成带芯片与容量的文件名");
    const suggested = `aether-${device.chip.toLowerCase()}-${device.flashSizeLabel.toLowerCase()}-${clock()}.bin`;
    const chosen = await flash.chooseBackupPath(suggested);
    if (chosen) { setOutputPath(chosen); setNotice("已选择保存位置；备份完成前不会生成最终文件。"); }
  });

  const startBackup = () => run(async () => {
    if (!port) throw new Error("请选择端口");
    if (!outputPath) throw new Error("请选择备份保存位置");
    const result = await flash.startBackup({ port, outputPath, ...options });
    setNotice(`备份完成：${result.outputPath}（${mib(result.metadata.fileLength)}，SHA-256 ${result.metadata.sha256.slice(0, 16)}…）`);
  });

  const chooseBackup = () => run(async () => {
    const chosen = await flash.chooseBackupFile();
    if (!chosen) return;
    setBackupFile(chosen); setPlan(null); setConfirmation(""); setMode("restore");
    const meta = await flash.readMetadata(chosen);
    setMetadata(meta);
    setNotice("已读取备份元数据；开始准备恢复前不会读取或写入设备。");
  });

  const prepare = () => run(async () => {
    if (!port) throw new Error("请选择端口");
    if (!backupFile) throw new Error("请选择备份文件");
    const next = await flash.prepareRestore({ port, backupPath: backupFile, ...options });
    setPlan(next); setConfirmation("");
    setNotice(next.blocked ? "恢复被拒绝，未写入任何数据。" : `比较完成：需要写入 ${next.ranges.length} 段。`);
  });

  const execute = () => run(async () => {
    if (!plan) throw new Error("请先准备恢复计划");
    const result = await flash.executeRestore(plan.planId, confirmation);
    setNotice(result.message);
    if (result.status !== "completed") setLocalError(result.message);
  });

  const cancel = () => run(() => flash.cancel());

  if (!isDesktop()) return <div className="p-5 text-[11px] text-[#9A702C]">Flash 备份/恢复需要 Electron 桌面端；浏览器预览不提供串口或 esptool 能力。</div>;

  return <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-base font-semibold text-[#26282C]">ESP Flash 备份 / 恢复</h1>
        <p className="mt-1 max-w-[720px] leading-5 text-[#90969E]">通过本机 esptool 按块读取 Flash 并逐块校验；只有全部块成功、长度与整片 SHA-256 计算完成后才生成成功备份。恢复采用两阶段：先只读比较并列出将写范围，用户输入确认文字后才写入，且逐段读回原始字节核对。全程不改 eFuse。</p>
      </div>
      {snapshot && <span className="rounded-full border border-[#E5E8EC] px-2 py-0.5 text-[10px]">{status === "idle" ? "空闲" : status === "backing-up" ? "备份中" : status === "restoring" ? "恢复中" : status === "detecting" ? "识别中" : "正在取消"}</span>}
    </div>

    <div className="mt-4 flex gap-1 rounded-md border border-[#E5E8EC] p-1 text-[11px]">
      {(["backup", "restore"] as const).map((item) => <button key={item} className={`flex-1 rounded px-3 py-1.5 ${mode === item ? "bg-[#F2F8FF] font-medium text-[#007AFF]" : "hover:bg-[#F8F9FB]"}`} onClick={() => setMode(item)} disabled={busy}>{item === "backup" ? "备份" : "恢复"}</button>)}
    </div>

    <section className="mt-4 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex items-center justify-between"><strong className="text-[#26282C]">1. 选择设备</strong><button className="btn px-2 py-1 text-[10px]" disabled={busy || portsLoading} onClick={refreshPorts}>{portsLoading ? "正在枚举…" : "刷新端口"}</button></div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="block flex-1">端口<select aria-label="端口" className="input mt-1 w-full" value={port} onChange={(event) => { setPort(event.target.value); setDevice(null); setPlan(null); setConfirmation(""); }} disabled={busy}>
          <option value="">{ports.length ? "请选择端口" : "尚未枚举到端口"}</option>
          {ports.map((item) => <option key={item.path} value={item.path}>{item.path} · {item.label}{item.detail ? ` · ${item.detail}` : ""}</option>)}
        </select></label>
        <button className="btn px-2 py-1 text-[10px]" disabled={busy || !port || detecting} onClick={detect}>{detecting ? "读取中…" : "读取设备信息"}</button>
      </div>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">端口列表来自操作系统；厂商/VID:PID 不能证明板型或固件。不自动识别未知设备，也不在未读取 Flash 大小前操作。</p>
      {device && <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-[#F8F9FB] p-2 text-[10px] sm:grid-cols-3">
        <span>芯片：<b>{device.chip}</b> {device.detail}</span>
        <span>修订：{device.revision || "—"}</span>
        <span>Flash：<b>{device.flashSizeLabel}</b>（{device.flashSizeBytes} 字节）</span>
        <span>厂商/型号：{device.flashManufacturerId || "—"} / {device.flashDeviceId || "—"}</span>
        <span>MAC：<span className="font-mono">{device.mac || "—"}</span></span>
        <span>特性：{device.features.join("、") || "—"}</span>
      </div>}
      {capabilities && <p className="mt-2 text-[10px] leading-5 text-[#90969E]">esptool {capabilities.version} · 读取 {capabilities.readFlash ? "可用" : "不可用"} · 写入 {capabilities.writeFlash ? "可用" : "不可用"} · 保留镜像头 {capabilities.preservesImageHeaders ? "可验证" : "不可验证"} · 安全信息 {capabilities.getSecurityInfo ? "只读可用" : "不可用"}。{!capabilities.writeFlash && " 恢复将被明确拒绝。"}</p>}
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <strong className="text-[#26282C]">2. 分块参数</strong>
      <div className="mt-2 flex flex-wrap gap-3">
        <label className="block">块大小<select aria-label="块大小" className="input mt-1" value={chunkKiB} onChange={(event) => setChunkKiB(Number(event.target.value))} disabled={busy}>{CHUNK_OPTIONS.map((value) => <option key={value} value={value}>{value} KiB</option>)}</select></label>
        <label className="block">波特率<select aria-label="波特率" className="input mt-1" value={baud} onChange={(event) => setBaud(Number(event.target.value))} disabled={busy}>{BAUD_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="block">每块重试<select aria-label="每块重试" className="input mt-1" value={retries} onChange={(event) => setRetries(Number(event.target.value))} disabled={busy}>{RETRY_OPTIONS.map((value) => <option key={value} value={value}>{value} 次</option>)}</select></label>
      </div>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">USB-Serial/JTAG 长读在高速率下容易损坏；失败时自动减半波特率重试，仍有上限。默认 512 KiB / 230400 baud。</p>
    </section>

    {mode === "backup" ? <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <strong className="text-[#26282C]">3. 备份到本机</strong>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn px-2 py-1 text-[10px]" disabled={busy || !device} onClick={chooseOutput}>选择保存位置</button>
        <span className="min-w-0 flex-1 break-all font-mono text-[10px]">{outputPath || "尚未选择"}</span>
        <button className="btn btn-primary px-3 py-1.5" disabled={busy || !port || !device || !outputPath} onClick={startBackup}>{status === "backing-up" ? "正在备份…" : "开始备份"}</button>
        {status === "backing-up" && <button className="btn px-3 py-1.5" onClick={cancel}>取消</button>}
      </div>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">备份不写入工程目录；完成后在所选位置生成 .bin 与 .meta.json（芯片/容量/MAC、文件长度、整片 SHA-256），不记录密钥或 eFuse 原始内容。</p>
      <ProgressBar progress={progress && (status !== "idle" || ["done", "failed", "cancelled"].includes(progress.phase)) ? progress : null} />
      {snapshot?.backup && <div className="mt-2 rounded bg-[#F2FBF6] p-2 text-[10px] leading-5">
        <div className="font-medium text-[#2B9661]">备份完成（已核对长度与摘要）</div>
        <div className="break-all font-mono">{snapshot.backup.outputPath}</div>
        <div>长度 {snapshot.backup.metadata.fileLength} 字节 · SHA-256 <span className="font-mono break-all">{snapshot.backup.metadata.sha256}</span></div>
        <div>分块 {snapshot.backup.metadata.chunkCount} 块 · 重试 {snapshot.backup.retriesUsed} 次 · 缓存 {snapshot.backup.cacheDir}</div>
      </div>}
    </section> : <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <strong className="text-[#26282C]">3. 从备份恢复</strong>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn px-2 py-1 text-[10px]" disabled={busy} onClick={chooseBackup}>选择备份文件</button>
        <span className="min-w-0 flex-1 break-all font-mono text-[10px]">{backupFile || "尚未选择"}</span>
        <button className="btn btn-primary px-3 py-1.5" disabled={busy || !port || !backupFile} onClick={prepare}>{status === "restoring" && !plan ? "正在比较…" : "只读比较并生成计划"}</button>
        {status === "restoring" && <button className="btn px-3 py-1.5" onClick={cancel}>取消</button>}
      </div>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">准备阶段只读取设备并与备份比较，不写任何字节。会核实备份长度/SHA-256、设备芯片/容量/厂商/MAC，以及 esptool 是否支持在不改写镜像头的情况下写入；任一项不满足都会明确拒绝。</p>
      {metadata && <div className="mt-2 rounded bg-[#F8F9FB] p-2 text-[10px] leading-5">
        <div>备份设备：{metadata.device.chip} · {metadata.device.flashSizeLabel} · MAC <span className="font-mono">{metadata.device.mac || "—"}</span></div>
        <div>长度 {metadata.fileLength} 字节 · SHA-256 <span className="font-mono break-all">{metadata.sha256}</span></div>
      </div>}
      <ProgressBar progress={progress && (status !== "idle" || ["done", "failed", "cancelled"].includes(progress.phase)) ? progress : null} />
      {plan && <div className="mt-2">
        <div className={`rounded p-2 text-[10px] leading-5 ${plan.blocked ? "bg-[#FFF5E7] text-[#9A702C]" : "bg-[#F8F9FB]"}`}>
          <div className="font-medium">{plan.blocked ? "已拒绝恢复" : plan.ranges.length === 0 ? "设备已与备份一致，无需写入" : `将写入 ${plan.ranges.length} 段，共 ${plan.totalBytes} 字节`}</div>
          {plan.blocked && <div>{plan.blocked}</div>}
          <div className="mt-1 grid gap-0.5"><Verification label="备份长度与元数据一致" ok={plan.verification.fileLength} blocked /><Verification label="备份为整片镜像（长度=Flash 容量）" ok={plan.verification.wholeImage} blocked /><Verification label="备份 SHA-256 一致" ok={plan.verification.sha256} blocked /><Verification label="设备与备份记录匹配（含 MAC）" ok={plan.verification.deviceMatch} blocked /><Verification label="安全启动/Flash 加密均关闭" ok={plan.verification.securityClear} blocked /></div>
          {plan.warnings.length > 0 && <ul className="mt-1 list-disc pl-4">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        </div>
        {plan.ranges.length > 0 && <div className="mt-1 max-h-[140px] overflow-auto rounded border border-[#E5E8EC]">
          <table className="w-full text-left text-[10px]"><thead className="sticky top-0 bg-[#F8F9FB]"><tr><th className="px-2 py-1">偏移</th><th className="px-2 py-1">长度</th></tr></thead><tbody>{plan.ranges.map((range) => <tr key={range.offset} className="border-t border-[#EEF0F3]"><td className="px-2 py-0.5 font-mono">{hex(range.offset)}</td><td className="px-2 py-0.5 font-mono">{range.size} B</td></tr>)}</tbody></table>
        </div>}
        {!plan.blocked && plan.ranges.length > 0 && <div className="mt-2 rounded border border-[#F0D9C0] bg-[#FFF9F2] p-2">
          <p className="text-[10px] leading-5 text-[#9A702C]">写入会覆盖上述范围，可能短时间使设备无法启动。不会擦除整片，不会修改 eFuse，不会传入 --flash_mode/--flash_freq/--flash_size；esptool 的 ESPTOOL_FF/FM/FS 也被固定为 keep。取消或失败时会报告已尝试/未尝试范围，且不会宣称恢复完成。比较结果是准备阶段的快照：准备后若设备运行过（固件可能写 NVS/OTA），未写入区域可能已经变化，建议重新准备。</p>
          <label className="mt-1 block">请输入 <b className="font-mono">{plan.confirmationPhrase}</b> 以确认<input aria-label="恢复确认文字" className="input mt-1 w-full font-mono" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} /></label>
          <button className="btn btn-primary mt-2 px-3 py-1.5" disabled={busy || confirmation !== plan.confirmationPhrase} onClick={execute}>{status === "restoring" ? "正在写入…" : "写入并读回核对"}</button>
        </div>}
      </div>}
      {snapshot?.restore && <div className={`mt-2 rounded p-2 text-[10px] leading-5 ${snapshot.restore.status === "completed" ? "bg-[#F2FBF6]" : "bg-[#FFF5E7]"}`}>
        <div className={`font-medium ${snapshot.restore.status === "completed" ? "text-[#2B9661]" : "text-[#9A702C]"}`}>{snapshot.restore.status === "completed" ? (snapshot.restore.writtenRanges.length ? "计划范围已写入并读回核对" : "无需写入（准备阶段比较一致）") : snapshot.restore.status === "cancelled" ? "恢复已取消（未完成）" : "恢复未完成"}</div>
        <div>{snapshot.restore.message}</div>
        {snapshot.progress?.failedOffset !== undefined && <div className="mt-1 font-mono text-[#D34A3D]">失败偏移：{hex(snapshot.progress.failedOffset)}</div>}
        {snapshot.restore.writtenRanges.length > 0 && <div className="mt-1">已尝试写入：{snapshot.restore.writtenRanges.map((range) => `${hex(range.offset)}+${range.size}${range.verified ? "✓" : "?"}`).join("，")}</div>}
        {snapshot.restore.remainingRanges.length > 0 && <div>未尝试写入：{snapshot.restore.remainingRanges.map((range) => `${hex(range.offset)}+${range.size}`).join("，")}</div>}
      </div>}
    </section>}

    {(localError || flash.error) && <p role="alert" className="mt-3 whitespace-pre-wrap rounded bg-[#FFF5E7] p-2 text-[10px] leading-5 text-[#A8741F]">{localError || flash.error}</p>}
    {notice && !localError && !flash.error && <p role="status" className="mt-3 rounded bg-[#F2F8FF] p-2 text-[10px] leading-5 text-[#3F6A9E]">{notice}</p>}
    {snapshot && <div className="mt-3 rounded border border-[#E5E8EC] p-2 text-[10px]"><div className="text-[#90969E]">缓存目录：<span className="font-mono break-all">{snapshot.cacheDir}</span></div>{snapshot.log.length > 0 && <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap bg-[#F8F9FB] p-2 font-mono text-[9px] leading-4">{snapshot.log.slice(-40).join("\n")}</pre>}</div>}
  </div>;
}

export const flashBackupPlugin: StudioPlugin = {
  manifest: {
    id: "aether.flash.backup",
    name: "ESP Flash 备份/恢复",
    version: "0.1.0",
    type: "tool",
    entry: "builtin/flashBackup.tsx",
    enabled: true,
    description: "通过本机 esptool 分块读取并校验 ESP Flash，保存到工程之外；恢复前只读比较、列出将写范围、要求显式确认，写入后读回原始字节核对。不修改 eFuse；无法安全写入时明确拒绝。",
    settings: [{ key: "esptool.cli", label: "esptool 可执行文件", type: "tool-path", tool: "esptool", placeholder: "例如 C:/Users/you/.platformio/packages/tool-esptoolpy/esptool.py" }],
    settingsHelp: "本功能只调用这里的单个 esptool 可执行文件或 esptool.py。留空时使用环境变量 AETHER_ESPTOOL，其次在 PATH 中查找 esptool.py。esptool.py 会通过 PlatformIO 自带的 Python 或 PATH 中的 Python 运行；也可直接填写 esptool 的 .exe。路径按单个参数传入，不经过 shell。",
  },
  activate(api) {
    api.register("panels", { id: "flash.backup", name: "Flash 备份/恢复", render: FlashBackupPanel });
    api.register("commands", { id: "flash.backup.open", name: "打开 ESP Flash 备份/恢复", run: () => useStudio.getState().setTab("panel:flash.backup") });
  },
};
