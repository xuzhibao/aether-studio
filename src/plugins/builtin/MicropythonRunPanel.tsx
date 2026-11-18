import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Play, RefreshCw, Square, Terminal } from "lucide-react";
import type { ToolStatus } from "../../../shared/tools";
import { isDesktop } from "../../lib/desktop";
import { useDisk } from "../../store/disk";
import { useFlash } from "../../store/flash";
import { useStudio } from "../../store/studio";
import { useTransport } from "../../store/transport";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function MicropythonRunPanel() {
  const root = useDisk((state) => state.root);
  const diskFiles = useDisk((state) => state.diskFiles);
  const tasks = useDisk((state) => state.tasks);
  const starting = useDisk((state) => state.starting);
  const files = useStudio((state) => state.files);
  const io = useTransport();
  const flashBusy = useFlash((state) => state.starting || (state.snapshot?.status ?? "idle") !== "idle");
  const [file, setFile] = useState("");
  const [port, setPort] = useState("");
  const [ports, setPorts] = useState<{ path: string; label: string; detail?: string }[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portsError, setPortsError] = useState("");
  const [tool, setTool] = useState<ToolStatus | null>(null);
  const [toolError, setToolError] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState("");
  const savedPython = Object.keys(diskFiles).filter((name) => name.toLowerCase().endsWith(".py")).sort();
  const savedKey = savedPython.join("\n");
  const dirty = !!file && Object.hasOwn(files, file) && files[file] !== diskFiles[file];
  const running = tasks.some((task) => task.status === "running") || starting;
  const projectTasks = tasks.filter((task) => task.provider === "micropython.run" && task.root === root);
  const task = (taskId ? tasks.find((item) => item.id === taskId) : undefined) ?? projectTasks.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);

  const loadTool = useCallback(async () => {
    const api = typeof window === "undefined" ? undefined : window.aether?.tools;
    if (!api) return;
    try {
      setTool(await api.status("mpremote"));
      setToolError("");
    } catch (reason) { setTool(null); setToolError(errorText(reason)); }
  }, []);

  const loadPorts = useCallback(async () => {
    const api = typeof window === "undefined" ? undefined : window.aether?.serial;
    if (!api) return;
    setPortsLoading(true); setPortsError("");
    try { setPorts(await api.list()); }
    catch (reason) { setPortsError(errorText(reason)); }
    finally { setPortsLoading(false); }
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    void loadTool();
    const off = window.aether?.tools.onChanged(() => { void loadTool(); });
    return () => { off?.(); };
  }, [loadTool]);

  useEffect(() => {
    if (!isDesktop()) return;
    void loadPorts();
  }, [loadPorts]);

  useEffect(() => {
    // A project switch must not keep a path that is no longer on disk.
    if (file && !savedPython.includes(file)) setFile("");
  }, [root, savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!isDesktop() || !file || !port.trim() || dirty || running || flashBusy || submitting) return;
    setSubmitting(true); setError(""); setNote("");
    const selectedRoot = root;
    try {
      if (!selectedRoot) throw new Error("请先打开工程目录");
      // The task runs the file on disk, never the editor buffer. Re-read the disk first so an external
      // change or a save race cannot make the UI's "saved" state stale.
      await useDisk.getState().refresh();
      const current = useDisk.getState();
      if (current.root !== selectedRoot) throw new Error("工程目录在运行前发生变化，已取消");
      if (!Object.hasOwn(current.diskFiles, file)) throw new Error("工程磁盘上没有这个已保存的 .py 文件：" + file);
      if (!file.toLowerCase().endsWith(".py")) throw new Error("只能运行 .py 文件");
      const buffer = useStudio.getState().files[file];
      if (Object.hasOwn(useStudio.getState().files, file) && buffer !== current.diskFiles[file]) {
        throw new Error("文件有未保存修改，请先保存（Ctrl+S）后再运行；不会运行缓冲区内容。");
      }
      // The monitor and the task share one port lease; release the monitor before starting.
      await useTransport.getState().disconnect();
      if (useTransport.getState().status !== "disconnected") throw new Error("串口监视器尚未释放端口，已取消运行。请手动断开后重试。");
      const started = await window.aether!.tasks.start("micropython.run", { port: port.trim(), file });
      useDisk.setState((state) => ({ tasks: [...state.tasks.filter((item) => item.id !== started.id), started] }));
      setTaskId(started.id);
      setNote("已启动真实 mpremote 运行任务；结果以进程退出码和日志为准。");
    } catch (reason) {
      setError(errorText(reason));
    } finally { setSubmitting(false); }
  };

  const cancel = async () => {
    if (!task || task.status !== "running") return;
    setSubmitting(true); setError("");
    try { await useDisk.getState().cancel(task.id); }
    catch (reason) { setError(errorText(reason)); }
    finally { setSubmitting(false); }
  };

  if (!isDesktop()) {
    return <div data-micropython-panel="browser" className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
      <h1 className="text-base font-semibold text-[#26282C]">在设备运行 Python</h1>
      <p className="mt-3 max-w-[720px] leading-6 text-[#9A702C]">在设备上运行 Python 需要 Electron 桌面端和本机 mpremote；浏览器预览不会连接串口，也不会伪装执行成功。</p>
    </div>;
  }

  const toolReady = !!tool?.available;
  const disabled = !root || !toolReady || !file || !port.trim() || dirty || running || flashBusy || submitting;
  const statusText = !task ? "" : task.status === "running" ? "运行中…" : task.status === "succeeded" ? "命令成功（退出码 0）" : task.status === "cancelled" ? "已取消" : "运行失败";

  return <div data-micropython-panel="desktop" className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="text-base font-semibold text-[#26282C]">在设备运行 Python</h1>
    <p className="mt-2 max-w-[760px] leading-5 text-[#90969E]">只运行当前工程目录中<strong>已保存</strong>的 .py 文件，命令固定为 <span className="font-mono">mpremote connect port:&lt;端口&gt; run &lt;本地文件&gt;</span>。端口必须手动选择或输入；不会使用 auto/list，不会安装固件，也不会上传板上持久文件。</p>

    <div data-micropython-warning="1" className="mt-3 rounded-md border border-[#F0D9C0] bg-[#FFF9F2] p-3 text-[10px] leading-5 text-[#9A702C]">
      <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={12} /> 运行会中断设备上正在执行的程序，并可能触发软重启。</p>
      <p className="mt-1">被执行的是脚本本身：它可以修改 GPIO、板上文件、网络等设备状态。Aether 只负责启动并显示真实退出码和日志，不保证脚本安全或可逆。</p>
    </div>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-[#26282C]">mpremote 工具</strong>
        <div className="flex items-center gap-2">
          <span role="status" data-mpremote-available={tool ? String(tool.available) : "unknown"} className={toolReady ? "text-[#2B9661]" : "text-[#A8741F]"}>{tool ? (toolReady ? "可用" : "不可用") : "正在读取…"}</span>
          <button type="button" className="btn px-2 py-1 text-[10px]" onClick={() => void loadTool()}><RefreshCw size={10} /> 重新检测</button>
        </div>
      </div>
      {toolReady && <p className="mt-1 break-all text-[10px] leading-5 text-[#90969E]">来源 {tool.source} · <span className="font-mono">{tool.executable}</span>{tool.version ? " · 版本 " + tool.version : " · 版本未读取（点“重新检测”实际运行 --version）"}</p>}
      {tool && !toolReady && <p role="alert" className="mt-1 leading-5 text-[#A8741F]">不可用：{tool.error || "找不到 mpremote"}。请在 Plugins → MicroPython 中填写 mpremote 可执行文件路径。</p>}
      {toolError && <p role="alert" className="mt-1 leading-5 text-[#A8741F]">{toolError}</p>}
      <button type="button" className="btn mt-2 px-2 py-1 text-[10px]" onClick={() => useStudio.getState().setDialog("plugins")}>打开插件设置</button>
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[240px] flex-1">工程中的已保存 .py 文件
          <select aria-label="MicroPython 文件" data-micropython-file className="input mt-1 w-full" value={file} onChange={(event) => { setFile(event.target.value); setError(""); setNote(""); }} disabled={running || submitting}>
            <option value="">{savedPython.length ? "请选择文件" : "当前工程没有已保存的 .py 文件"}</option>
            {savedPython.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="block min-w-[220px] flex-1">设备端口（手动选择或输入）
          <input aria-label="MicroPython 端口" data-micropython-port list="micropython-run-ports" className="input mt-1 w-full font-mono" value={port} onChange={(event) => { setPort(event.target.value); setError(""); }} placeholder="COM3 / /dev/ttyACM0 / /dev/cu.usbmodem…" disabled={running || submitting} />
          <datalist id="micropython-run-ports">{ports.map((item) => <option key={item.path} value={item.path}>{item.label}</option>)}</datalist>
        </label>
        <button type="button" className="btn px-2 py-1 text-[10px]" disabled={portsLoading || running || submitting} onClick={() => void loadPorts()}><RefreshCw size={10} /> {portsLoading ? "枚举中…" : "刷新端口"}</button>
      </div>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">端口列表来自操作系统，只用于手动选择；不会自动挑选端口，也不会向 mpremote 传入 auto、list 或裸命令。</p>
      {!root && <p role="status" className="mt-2 rounded bg-[#FFF5E7] p-2 text-[10px] leading-5 text-[#A8741F]">请先打开磁盘工程目录；浏览器中的内存工程不会运行，因为 mpremote 需要本地 .py 文件。</p>}
      {!savedPython.length && <p className="mt-1 text-[10px] text-[#A8741F]">先在工程文件树中创建并保存 .py 文件，或在编辑器中按 Ctrl+S 保存。未保存的缓冲区不会运行。</p>}
      {portsError && <p role="alert" className="mt-1 text-[10px] text-[#A8741F]">{portsError}</p>}
      {!portsLoading && !ports.length && !portsError && <p className="mt-1 text-[10px] text-[#90969E]">未枚举到端口；可以手动输入明确的串口路径。</p>}
      {dirty && <p role="alert" data-micropython-dirty="1" className="mt-2 rounded bg-[#FFF5E7] p-2 text-[10px] leading-5 text-[#A8741F]">文件有未保存修改：请先保存（Ctrl+S）。运行的是磁盘上的已保存版本，不会使用缓冲区内容。</p>}
      {running && <p role="status" className="mt-2 text-[10px] text-[#A8741F]">已有任务或构建在进行，运行需等待它结束或取消。</p>}
      {flashBusy && <p role="status" className="mt-2 text-[10px] text-[#A8741F]">Flash 备份/恢复正在占用设备，运行已暂时禁用。</p>}
      {io.status !== "disconnected" && <p role="status" data-micropython-monitor={io.status} className="mt-2 text-[10px] text-[#A8741F]">串口监视器当前为 {io.status}；运行前会尝试断开，若无法释放端口会取消并显示原因。</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" data-micropython-run className="btn btn-primary px-3 py-1.5 text-[11px]" disabled={disabled} onClick={() => void start()}><Play size={11} /> {submitting ? "正在启动…" : task?.status === "running" ? "正在运行…" : "在设备运行"}</button>
        {task?.status === "running" && <button type="button" className="btn px-3 py-1.5 text-[11px]" disabled={submitting} onClick={() => void cancel()}><Square size={10} /> 取消</button>}
      </div>
      {error && <p role="alert" className="mt-2 whitespace-pre-wrap rounded bg-[#FFF5E7] p-2 text-[10px] leading-5 text-[#A8741F]">{error}</p>}
      {note && <p role="status" className="mt-2 rounded bg-[#F2F8FF] p-2 text-[10px] leading-5 text-[#3F6A9E]">{note}</p>}
    </section>

    {task && <section data-micropython-task={task.id} data-micropython-status={task.status} className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2"><Terminal size={12} /><strong className="text-[#26282C]">运行任务</strong><span role="status">{statusText}</span><span className="text-[10px] text-[#90969E]">exit {task.exitCode ?? "—"}</span><span className="text-[10px] text-[#90969E]">端口 {task.options?.port ?? "—"} · 文件 {task.options?.file ?? "—"}</span></div>
      {task.error && <p role="alert" className="mt-2 text-[#A8741F]">{task.error}</p>}
      <pre className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap rounded bg-[#F8F9FB] p-2 font-mono text-[10px] leading-5">{task.log.slice(-8000)}</pre>
      <p className="mt-2 text-[10px] leading-5 text-[#90969E]">退出码 0 只说明 mpremote 命令结束；它不证明脚本没有修改设备状态，也不代表设备已按预期启动。失败时请查看日志和错误信息。</p>
    </section>}
  </div>;
}
