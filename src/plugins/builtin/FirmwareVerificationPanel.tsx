import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleSlash, Cpu, FlaskConical, Play, RefreshCw, ShieldCheck, Square, Usb } from "lucide-react";
import type { ToolStatus } from "../../../shared/tools";
import type { VerificationStatusView } from "../../../shared/firmwareVerification";
import type { TransportPort } from "../api";
import { isDesktop } from "../../lib/desktop";
import { useDisk, waitForTask } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { useTransport } from "../../store/transport";

const hex = (value: number) => "0x" + value.toString(16).toUpperCase();
const short = (value: string, size = 16) => (value.length > size ? value.slice(0, size) + "…" : value);

function Badge({ done, label }: { done: boolean; label: string }) {
  return <span className={"inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] " + (done ? "bg-[#EAF7EF] text-[#2F7B4F]" : "bg-[#F3F4F6] text-[#90969E]")}>
    {done ? <CheckCircle2 size={10} /> : <CircleSlash size={10} />}{label}
  </span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-2 py-0.5"><span className="w-[104px] flex-none text-[#90969E]">{label}</span><span className="min-w-0 break-all text-[#3B424A]">{children}</span></div>;
}

export function FirmwareVerificationPanel() {
  const root = useDisk((state) => state.root);
  const environments = useDisk((state) => state.environments);
  const environment = useDisk((state) => state.environment);
  const tasks = useDisk((state) => state.tasks);
  const starting = useDisk((state) => state.starting);
  const preflight = useDisk((state) => state.espPreflight);
  const loadEnvironments = useDisk((state) => state.loadEnvironments);
  const setEnvironment = useDisk((state) => state.setEnvironment);
  const [status, setStatus] = useState<VerificationStatusView | null>(null);
  const [tool, setTool] = useState<ToolStatus | null>(null);
  const [ports, setPorts] = useState<TransportPort[]>([]);
  const [port, setPort] = useState("");
  const [transport, setTransport] = useState<"usb-serial-jtag" | "uart0">("usb-serial-jtag");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState("");

  const api = typeof window === "undefined" ? undefined : window.aether?.firmwareVerification;
  const evidence = status?.evidence ?? null;
  const hardware = status?.hardware ?? null;

  const upload = useMemo(() => tasks
    .filter((task) => task.provider === "esp.upload" && task.root === root && task.environment === environment && String(task.options?.port ?? "").toUpperCase() === port.trim().toUpperCase())
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1), [tasks, root, environment, port]);
  const buildTask = useMemo(() => tasks
    .filter((task) => task.provider === "platformio.build" && task.root === root && (!environment || task.environment === environment))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1), [tasks, root, environment]);

  const refreshPorts = useCallback(() => {
    const serial = window.aether?.serial;
    if (!serial) return;
    setListing(true);
    void serial.list().then((items) => {
      setPorts(items);
      setPort((current) => (items.some((item) => item.path === current) ? current : (items[0]?.path ?? "")));
    }, (reason) => setError(String(reason))).finally(() => setListing(false));
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

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const saveAndBuild = () => run(async () => {
    if (!environment.trim()) throw new Error("请先在工程中选择一个 PlatformIO 环境");
    setEnvironment(environment);
    const task = await useDisk.getState().build("platformio.build", { environment });
    const settled = await waitForTask(task.id);
    if (settled.status !== "succeeded") throw new Error("构建未通过（" + settled.status + "）：" + (settled.error || "见 Build Tasks 日志"));
  });

  const verify = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    if (!evidence || !evidence.passed) setStatus(await api.status());
    await api.startSimulation({ environment, boots: 2 });
  });

  const arm = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    if (!port.trim()) throw new Error("请先选择实机串口");
    if (!confirmed) throw new Error("请先勾选确认写入范围");
    await api.armDeploy({ port: port.trim() });
    useTransport.getState().setPreferredAddress(port.trim(), "native-serial");
    useStudio.getState().setDialog("deploy");
  });

  const challenge = () => run(async () => {
    if (!api) throw new Error("固件验证需要 Electron 桌面端");
    await api.runDevice({ port: port.trim(), transport });
  });

  const portBusy = busy || starting || tasks.some((task) => task.status === "running");
  // Every stage is bound to the current project, environment and port. A record from another
  // target stays in the host evidence file but never lights up this panel's badges.
  const evidenceMatches = !!evidence && evidence.root === root && evidence.environment === environment;
  const simulated = !!evidence?.passed && evidenceMatches;
  const preflightMatches = !!preflight && preflight.port === port.trim() && preflight.environment === environment;
  const preflightOk = preflightMatches && !!preflight?.supported && preflight.ok;
  const uploaded = upload?.status === "succeeded";
  const appMatches = uploaded && !!evidence && evidenceMatches && (upload.metadata as { simulation?: { appSha256?: string } } | undefined)?.simulation?.appSha256?.toLowerCase() === evidence.appSha256;
  const hardwareMatches = !!hardware && hardware.root === root && hardware.port === port.trim() && hardware.environment === environment;
  const hardwarePassed = hardwareMatches && !!hardware?.passed;

  if (!isDesktop()) {
    return <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
      <h1 className="text-base font-semibold">Firmware Verification（固件验证）</h1>
      <p className="mt-2 rounded bg-[#FFF5E7] p-2 text-[#9A702C]">真实 QEMU 与实机串口挑战需要 Electron 桌面端。</p>
    </div>;
  }

  return <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="flex items-center gap-2 text-base font-semibold"><FlaskConical size={15} /> Firmware Verification（固件验证）</h1>
    <p className="mt-1 leading-5 text-[#90969E]">对 <span className="font-mono">examples/esp32c3-firmware-validation</span>（ESP-IDF 5.4.1，env <span className="font-mono">esp32c3-qemu-uart0</span>）这类 ESP32-C3 验证工程：真实 PlatformIO 构建 → 真实 Espressif QEMU 启动并由宿主随机挑战 → 只写活动 OTA 槽中的同一 app 镜像 → 新串口会话再次挑战。QEMU 只模拟 SoC 与 UART，不是电路电气仿真，也不代表所有固件或所有开发板。</p>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Badge done={simulated} label="已仿真" /><Badge done={preflightOk} label="预检通过" /><Badge done={uploaded && appMatches} label="上传完成" /><Badge done={hardwarePassed} label="实机行为通过" />
      {status?.running && <span className="text-[10px] text-[#2F7FD8]">验证运行中…</span>}
    </div>

    <section className="mt-4 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>1 · 工程与环境</strong>
        <span className="text-[10px] text-[#90969E]">{root || "未打开工程目录"}</span>
        <button className="btn ml-auto px-2 py-1 text-[10px]" disabled={listing} onClick={refreshPorts}><RefreshCw size={10} /> 刷新端口</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">环境
          <select aria-label="验证环境" className="input h-[26px] px-2" disabled={portBusy} value={environment} onChange={(event) => setEnvironment(event.target.value)}>
            {!environments.length && <option value="">未发现环境</option>}
            {environments.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <button className="btn px-2 py-1 text-[10px]" disabled={portBusy || !root || !environment} onClick={() => void saveAndBuild()}>保存并构建</button>
        <span className="text-[10px] text-[#90969E]">{buildTask ? "最近构建：" + buildTask.status + (buildTask.error ? "（" + buildTask.error + "）" : "") : "尚无构建记录"}</span>
      </div>
      <div className="mt-2 rounded bg-[#F8F9FB] p-2 font-mono text-[10px]">
        <Field label="QEMU 工具">{tool ? (tool.available ? short(tool.executable, 72) : "未找到：" + (tool.error || tool.executable)) : "未检测"}</Field>
        <Field label="版本">{tool?.version || "—"}</Field>
      </div>
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>2 · 真实 QEMU 验证</strong>
        <span className="text-[10px] text-[#90969E]">两次独立启动，每次新随机挑战；由 shared/firmwareValidation.ts 判定。</span>
        {status?.running
          ? <button className="btn ml-auto px-2 py-1 text-[10px]" onClick={() => void api?.cancel()}><Square size={10} /> 取消</button>
          : <button className="btn btn-primary ml-auto px-2 py-1 text-[10px]" disabled={portBusy || !root || !environment || !tool?.available} onClick={() => void verify()}><Play size={10} /> 启动 QEMU 验证</button>}
      </div>
      {evidence && <>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
          <span className={evidence.passed && evidenceMatches ? "text-[#2F7B4F]" : "text-[#A8741F]"}>{evidence.passed && evidenceMatches ? "QEMU 挑战通过" : evidence.passed ? "该记录属于其他工程或环境，不适用于当前选择" : "QEMU 验证未通过"}</span>
          <span>env {evidence.environment}</span><span>fwid {evidence.identity.fwid || "—"}</span><span>启动 {evidence.boots.length} 次 · 标识{evidence.identity.stable ? "一致" : "不一致"}</span>
        </div>
        <div className="mt-2 space-y-0.5 font-mono text-[10px]">
          <Field label="app SHA-256">{evidence.appSha256 || "—"}</Field>
          <Field label="输入指纹">{evidence.inputHash || "—"}</Field>
          <Field label="QEMU">{short(evidence.boots[0]?.qemu.executable ?? "—", 72)} · {evidence.boots[0]?.qemu.version || "—"}</Field>
          <Field label="QEMU flash">{evidence.boots[0]?.flash.sha256.slice(0, 32) + "…"}（{evidence.boots[0]?.flash.size} 字节，私有副本）</Field>
          <Field label="记录时间">{new Date(evidence.recordedAt).toLocaleString("en-GB", { hour12: false })}</Field>
        </div>
        {evidence.error && <p role="alert" className="mt-2 text-[#A8741F]">{evidence.error}</p>}
        <table className="mt-2 w-full border-collapse text-[10px]">
          <thead><tr className="text-left text-[#90969E]"><th className="border-b border-[#EEF0F3] py-1">启动</th><th className="border-b border-[#EEF0F3]">判定</th><th className="border-b border-[#EEF0F3]">挑战</th><th className="border-b border-[#EEF0F3]">响应值</th><th className="border-b border-[#EEF0F3]">PID</th></tr></thead>
          <tbody>{evidence.boots.map((boot, index) => <tr key={index} className="font-mono">
            <td className="py-0.5">#{index + 1}</td>
            <td className={boot.record.verdict === "pass" ? "text-[#2F7B4F]" : "text-[#A8741F]"}>{boot.record.verdict}{boot.record.failure ? " · " + boot.record.failure.code : ""}</td>
            <td>{boot.record.challenge?.token ?? "—"}</td>
            <td>{boot.record.response?.value ?? "—"}</td>
            <td>{boot.pid ?? "—"}</td>
          </tr>)}</tbody>
        </table>
        <details className="mt-2"><summary className="cursor-pointer text-[10px] text-[#90969E]">最后一段真实 QEMU UART</summary>
          <pre className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap rounded bg-[#F8F9FB] p-2 font-mono text-[10px] leading-5">{(status?.running ? status.live?.uart : evidence.boots.at(-1)?.uartTail)?.slice(-3000) || "—"}</pre>
        </details>
      </>}
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>3 · 实机写入（既有部署流程 · app-only）</strong>
        <span className="text-[10px] text-[#90969E]">只写活动 OTA 槽中的单一 app 段；不写 bootloader、分区表、otadata、phy_init、model 或 ota_0。</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">端口
          <select aria-label="实机端口" className="input h-[26px] px-2" disabled={portBusy} value={port} onChange={(event) => { setPort(event.target.value); setConfirmed(false); }}>
            {!ports.length && <option value="">未枚举到端口</option>}
            {ports.map((item) => <option key={item.path} value={item.path}>{item.path} · {item.label}</option>)}
          </select>
        </label>
        <button className="btn px-2 py-1 text-[10px]" disabled={portBusy || !port} onClick={() => void run(async () => {
          const esp = window.aether?.esp;
          if (!esp) throw new Error("ESP 预检需要 Electron 桌面端");
          const result = await esp.preflight({ environment, port: port.trim() });
          useDisk.setState({ espPreflight: result });
          setConfirmed(false);
        })}><ShieldCheck size={10} /> 只读预检</button>
        <button className="btn btn-primary px-2 py-1 text-[10px]" disabled={portBusy || !simulated || !preflightOk || !confirmed || !port} onClick={() => void arm()}><Usb size={10} /> 启用 app-only 并打开部署</button>
      </div>
      <label className="mt-2 flex items-start gap-1.5 text-[10px] leading-5 text-[#59616A]">
        <input type="checkbox" className="mt-0.5" checked={confirmed} disabled={!preflightOk} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>我已核对端口、芯片与写入范围：本次只写入已仿真通过的同一 app SHA（{evidence?.appSha256 ? short(evidence.appSha256, 20) : "—"}），不触碰其他分区。</span>
      </label>
      {preflight && <div className="mt-2 rounded bg-[#F8F9FB] p-2 text-[10px] leading-5">
        <span className={preflight.ok ? "text-[#2F7B4F]" : "text-[#A8741F]"}>{preflight.supported ? (preflight.ok ? "部署前核对通过" : "部署前核对已阻止写入") : "该工程不是 ESP 目标"}</span>
        <span className="ml-2">{preflight.port} · env {preflight.environment}</span>
        {preflight.findings.length > 0 && <ul className="mt-1 list-disc pl-4">{preflight.findings.map((finding) => <li key={finding.id} className={finding.severity === "block" ? "text-[#A8741F]" : "text-[#59616A]"}>{finding.title}：{finding.detail}</li>)}</ul>}
      </div>}
      {upload && <div className="mt-2 rounded bg-[#F8F9FB] p-2 text-[10px] leading-5">
        <span>最近上传：{upload.status}（退出码 {upload.exitCode ?? "—"}，端口 {upload.options?.port ?? "—"}）</span>
        {upload.status === "succeeded" && <span className={"ml-2 " + (appMatches ? "text-[#2F7B4F]" : "text-[#A8741F]")}>{appMatches ? "写入的 app SHA 与仿真一致" : "写入的 app 与本面板仿真记录不一致"}</span>}
        {upload.error && <span className="ml-2 text-[#A8741F]">{upload.error}</span>}
        {upload.status === "succeeded" && !appMatches && <p className="text-[#A8741F]">退出码 0 只说明命令结束；没有同镜像的仿真绑定，不能视为本次验证部署。</p>}
      </div>}
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong>4 · 独立实机挑战</strong>
        <span className="text-[10px] text-[#90969E]">部署完成后新开串口会话，由宿主生成新挑战；回包必须与 QEMU 中同一镜像的标识一致。</span>
        <button className="btn btn-primary ml-auto px-2 py-1 text-[10px]" disabled={portBusy || !port || !appMatches} onClick={() => void challenge()}><Cpu size={10} /> 运行实机挑战</button>
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-[10px]">通道
        <select aria-label="实机挑战通道" className="input h-[24px] px-2" disabled={portBusy} value={transport} onChange={(event) => setTransport(event.target.value as "usb-serial-jtag" | "uart0")}>
          <option value="usb-serial-jtag">USB-Serial/JTAG（原生 USB）</option>
          <option value="uart0">UART0（经 USB-UART 桥）</option>
        </select>
        <button className="btn ml-1 px-2 py-0.5 text-[10px]" onClick={refreshPorts} disabled={listing}><RefreshCw size={10} /> 重新枚举</button>
      </label>
      {hardware && hardwareMatches && <div className="mt-2 space-y-0.5 font-mono text-[10px]">
        <Field label="结论">{hardware.passed ? "实机挑战通过并已绑定本次部署" : (hardware.bound ? "挑战通过，但未通过绑定核对" : hardware.reason || "未通过")}</Field>
        <Field label="通道">{hardware.transport} · 会话 #{hardware.sessionId}（新开）</Field>
        <Field label="挑战">{hardware.record.challenge?.token ?? "—"}</Field>
        <Field label="响应">{hardware.record.response?.value ?? "—"}（期望 {hardware.record.expectedValue ?? "—"}）</Field>
        <Field label="app SHA-256">{hardware.appSha256 ?? "未绑定"}</Field>
        <Field label="部署计划摘要">{hardware.planSha256 ? short(hardware.planSha256, 32) : "未绑定"}</Field>
        {hardware.record.failure && <Field label="失败原因">{hardware.record.failure.code} · {hardware.record.failure.detail}</Field>}
      </div>}
      {hardwarePassed && <p className="mt-2 text-[10px] text-[#2F7B4F]">四阶段闭环：已仿真 → 预检通过 → 上传完成 → 实机行为通过。仍只代表该示例固件在本次端口与板卡上的一次真实运行。</p>}
    </section>

    {error && <p role="alert" className="mt-3 whitespace-pre-wrap rounded bg-[#FFF5E7] p-2 text-[#9A702C]">{error}</p>}
    {status?.error && <p role="status" className="mt-2 whitespace-pre-wrap text-[10px] text-[#A8741F]">{status.error}</p>}
    <p className="mt-4 text-[10px] leading-5 text-[#90969E]">过期证据会被拒绝：工程文件、环境、app SHA 或端口任一变化，写入前都会重新核对；构建产物被替换、跨工程复用记录、串口被占用或设备无响应都不会被判为通过。CLI 脚本可补充证据，但成功实机流程以本面板的真实运行记录为准。</p>
  </div>;
}
