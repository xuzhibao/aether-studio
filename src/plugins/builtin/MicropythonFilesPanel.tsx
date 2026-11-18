import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Download, Folder, FileText, RefreshCw, Usb, X } from "lucide-react";
import type { MicropythonFileEntry, MicropythonListing } from "../../../shared/micropython";
import { isDesktop } from "../../lib/desktop";
import { useStudio } from "../../store/studio";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatSize = (bytes: number) => bytes >= 1024 ? (bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1) + " KB" : bytes + " B";
const parentOf = (path: string) => path === "/" ? "/" : path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * Read-only board files. The port, directory and entry of one operation are captured when it starts,
 * so a late reply for an old directory can never overwrite the directory the user is looking at now.
 */
export function MicropythonFilesPanel() {
  const [port, setPort] = useState("");
  const [ports, setPorts] = useState<{ path: string; label: string; detail?: string }[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portsError, setPortsError] = useState("");
  const [path, setPath] = useState("/");
  const [listing, setListing] = useState<MicropythonListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [downloading, setDownloading] = useState("");
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const sequence = useRef(0);
  const current = useRef({ port: "", path: "/" });
  current.current = { port, path };
  const api = typeof window === "undefined" ? undefined : window.aether?.micropython;
  const busyNow = loading || busy || choosing;

  const loadPorts = useCallback(async () => {
    const serial = typeof window === "undefined" ? undefined : window.aether?.serial;
    if (!serial) return;
    setPortsLoading(true); setPortsError("");
    try { setPorts(await serial.list()); }
    catch (reason) { setPortsError(errorText(reason)); }
    finally { setPortsLoading(false); }
  }, []);

  useEffect(() => { if (isDesktop()) void loadPorts(); }, [loadPorts]);

  const open = useCallback(async (nextPort: string, nextPath: string) => {
    if (!api || !nextPort.trim()) return;
    const token = ++sequence.current;
    setLoading(true); setError(""); setNote("");
    try {
      const result = await api.list(nextPort.trim(), nextPath);
      // A reply for a port/path the user already left must not replace the current directory.
      if (token !== sequence.current) return;
      if (result.port !== nextPort.trim() || result.path !== nextPath) return;
      setListing(result); setPath(nextPath);
    } catch (reason) {
      if (token !== sequence.current) return;
      setListing(null); setError(errorText(reason));
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }, [api]);

  // Typing only edits the field; a listing starts on Enter or the explicit button, never per keystroke.
  const choosePort = (value: string) => {
    sequence.current++;
    setPort(value); setPath("/"); setListing(null); setError(""); setNote("");
  };

  const enter = (entry: MicropythonFileEntry) => {
    if (entry.type !== "directory" || busyNow) return;
    void open(port, entry.path);
  };

  const download = async (entry: MicropythonFileEntry) => {
    if (!api || !listing || entry.type !== "file" || busyNow) return;
    // Capture the operation's port and path now; later navigation does not change what is downloaded.
    const origin = { port: listing.port, path: entry.path, name: entry.name };
    setError(""); setNote("");
    let target: string | null;
    try { target = await api.chooseDownloadPath(origin.name); }
    catch (reason) { setError(errorText(reason)); return; }
    if (!target) return;
    setBusy(true); setDownloading(origin.path);
    try {
      const result = await api.download(origin.port, origin.path, target);
      setNote("已保存 " + origin.name + " → " + result.target + "（" + formatSize(result.size) + "）");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); setDownloading(""); }
  };

  const cancel = async () => {
    try { await api?.cancel(); } catch (reason) { setError(errorText(reason)); }
  };

  if (!isDesktop()) {
    return <div data-micropython-files="browser" className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
      <h1 className="text-base font-semibold text-[#26282C]">板载文件</h1>
      <p className="mt-3 max-w-[720px] leading-6 text-[#9A702C]">浏览设备文件需要 Electron 桌面端和本机 mpremote；浏览器预览不会连接串口。</p>
    </div>;
  }

  const entries = listing ? [...listing.entries].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1) : [];

  return <div data-micropython-files="desktop" className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="text-base font-semibold text-[#26282C]">板载文件</h1>
    <p className="mt-2 max-w-[760px] leading-5 text-[#90969E]">只读浏览设备上的文件：<span className="font-mono">mpremote connect port:&lt;端口&gt; resume fs ls</span> 列目录，<span className="font-mono">resume fs cp</span> 下载单个文件到本机新文件。不上传、不删除、不改名，也不在板上安装任何内容。</p>

    <div data-micropython-files-warning className="mt-3 rounded-md border border-[#F0D9C0] bg-[#FFF9F2] p-3 text-[10px] leading-5 text-[#9A702C]">
      <p className="flex items-center gap-1.5 font-medium"><AlertTriangle size={12} /> resume 只是跳过自动软复位；mpremote 进入 raw REPL 时仍会发送中断，可能暂停设备上正在运行的程序。</p>
    </div>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-[240px] flex-1">设备端口（手动选择或输入）
          <input aria-label="MicroPython 文件端口" data-micropython-files-port list="micropython-files-ports" className="input mt-1 w-full font-mono" value={port} onChange={(event) => choosePort(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void open(port, "/"); } }} placeholder="COM3 / /dev/ttyACM0 / /dev/cu.usbmodem…" disabled={busyNow} />
          <datalist id="micropython-files-ports">{ports.map((item) => <option key={item.path} value={item.path}>{item.label}</option>)}</datalist>
        </label>
        <button type="button" className="btn px-2 py-1 text-[10px]" disabled={portsLoading || busyNow} onClick={() => void loadPorts()}><RefreshCw size={10} /> {portsLoading ? "枚举中…" : "刷新端口"}</button>
        <button type="button" data-micropython-files-root className="btn px-3 py-1 text-[10px]" disabled={!port.trim() || busyNow} onClick={() => void open(port, "/")}>打开根目录</button>
      </div>
      <p className="mt-1 text-[10px] leading-5 text-[#90969E]">端口必须手动选择或输入；不会自动挑选，也不会向 mpremote 传入 auto、list 或裸命令。</p>
      {portsError && <p role="alert" className="mt-1 text-[10px] text-[#A8741F]">{portsError}</p>}
      {!portsLoading && !ports.length && !portsError && <p className="mt-1 text-[10px] text-[#90969E]"><Usb size={10} className="inline" /> 未枚举到端口；可以手动输入明确的串口路径。</p>}
    </section>

    <section className="mt-3 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-micropython-files-up className="btn px-2 py-1 text-[10px]" disabled={!listing || path === "/" || busyNow} onClick={() => void open(port, parentOf(path))}><ArrowUp size={10} /> 上一级</button>
        <span data-micropython-files-path className="font-mono text-[11px] text-[#26282C]">{path}</span>
        <button type="button" className="btn ml-auto px-2 py-1 text-[10px]" disabled={!port.trim() || busyNow} onClick={() => void open(port, path)}><RefreshCw size={10} /> 刷新目录</button>
        {busyNow && !choosing && <button type="button" data-micropython-files-cancel className="btn px-2 py-1 text-[10px]" onClick={() => void cancel()}><X size={10} /> {busy ? "取消下载" : "取消读取"}</button>}
      </div>
      {loading && <p role="status" className="mt-2 text-[10px] text-[#90969E]">正在读取 {path} …</p>}
      {choosing && <p role="status" data-micropython-files-choosing className="mt-2 text-[10px] text-[#90969E]">请在系统保存对话框中选择位置或取消；在对话框关闭前不会写入任何本地文件。</p>}
      {!listing && !loading && !error && <p className="mt-2 text-[10px] text-[#90969E]">输入端口后按 Enter 或点“打开根目录”开始；不会自动挑选端口。</p>}
      {listing && !loading && entries.length === 0 && <p data-micropython-files-empty role="status" className="mt-2 rounded bg-[#F8F9FB] p-2 text-[10px] text-[#90969E]">该目录为空。</p>}
      {entries.length > 0 && <ul className="mt-2 divide-y divide-[#F0F2F5] rounded-md border border-[#E9EBEE]">
        {entries.map((entry) => <li key={entry.path} className="flex items-center gap-2 px-2 py-1.5">
          {entry.type === "directory" ? <Folder size={12} className="text-[#A8741F]" /> : <FileText size={12} className="text-[#7D848C]" />}
          {entry.type === "directory"
            ? <button type="button" data-micropython-files-dir={entry.path} className="min-w-0 flex-1 truncate text-left hover:underline" disabled={busyNow} onClick={() => enter(entry)}>{entry.name}</button>
            : <span data-micropython-files-file={entry.path} className="min-w-0 flex-1 truncate">{entry.name}</span>}
          <span className="w-[72px] shrink-0 text-right text-[10px] text-[#90969E]">{entry.type === "directory" ? "目录" : formatSize(entry.size)}</span>
          {entry.type === "file"
            ? <button type="button" data-micropython-files-download={entry.path} className="btn px-2 py-0.5 text-[10px]" disabled={busyNow} onClick={() => void download(entry)}><Download size={10} /> {downloading === entry.path ? "下载中…" : "下载"}</button>
            : <span className="btn pointer-events-none px-2 py-0.5 text-[10px] opacity-40">进入</span>}
        </li>)}
      </ul>}
      {error && <p role="alert" className="mt-2 whitespace-pre-wrap rounded bg-[#FFF5E7] p-2 text-[10px] leading-5 text-[#A8741F]">{error}</p>}
      {note && <p role="status" className="mt-2 break-all rounded bg-[#F2F8FF] p-2 text-[10px] leading-5 text-[#3F6A9E]">{note}</p>}
      <p className="mt-2 text-[10px] leading-5 text-[#90969E]">下载先写入私有临时文件，mpremote 成功后才以排他复制交付；已存在的本地文件不会被覆盖。设备上正在运行的程序可能被中断。</p>
    </section>

    <button type="button" className="btn mt-3 self-start px-2 py-1 text-[10px]" onClick={() => useStudio.getState().setTab("panel:micropython.run")}>打开“在设备运行 Python”</button>
  </div>;
}
