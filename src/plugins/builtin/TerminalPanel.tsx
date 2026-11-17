import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { usePlugins } from "../usePlugins";
import { useDisk } from "../../store/disk";
import { useTerminal } from "../../store/terminal";
import { isDesktop } from "../../lib/desktop";
export default function TerminalPanel() {
  const provider = usePlugins().require("terminals", "system-shell");
  const { snapshot, error } = useTerminal(); const root = useDisk((state) => state.root);
  const element = useRef<HTMLDivElement>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (isDesktop()) return provider.mount(element.current!); }, [provider]);
  const run = (action: () => Promise<void>) => { setBusy(true); void action().catch((error) => useTerminal.setState({ error: String(error) })).finally(() => setBusy(false)); };
  const running = snapshot?.status === "running";
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-white p-4 text-[11px] text-[#59616A]">
    <div className="flex flex-wrap items-center gap-2"><h1 className="mr-auto text-base font-semibold">Terminal</h1><button className="btn px-3 py-1.5" disabled={!isDesktop() || !root || busy || running} onClick={() => run(async () => { if (root) await provider.start(root); })}>Start terminal</button><button className="btn px-3 py-1.5" disabled={!running || busy} onClick={() => run(provider.interrupt)}>Interrupt</button><button className="btn px-3 py-1.5" disabled={!running || busy} onClick={() => run(provider.stop)}>Stop terminal</button><button className="btn px-3 py-1.5" disabled={!isDesktop() || busy} onClick={() => run(provider.clear)}>Clear terminal</button></div>
    <p className="mt-2 leading-5">本机交互式 shell，具有当前用户的文件与进程权限。只使用已保存文件；Ctrl+C 中断前台命令。切换面板会保留会话，停用插件或切换工程会关闭会话。</p>
    {!root && <p className="mt-2 text-[#A8741F]">请先打开或保存到磁盘工程目录。</p>}
    {!isDesktop() && <p className="mt-2 text-[#A8741F]">浏览器预览不能启动本机终端。</p>}
    <div className="my-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px]"><span role="status" data-terminal-status={snapshot?.status ?? "idle"}>{snapshot?.status ?? "尚未启动"}</span>{snapshot && <><span>{snapshot.shell} · PID {snapshot.pid} · {snapshot.cols} × {snapshot.rows}</span>{snapshot.exitCode !== null && <span>exit {snapshot.exitCode}{snapshot.signal ? ` · signal ${snapshot.signal}` : ""}</span>}<span className="basis-full break-all">启动目录：{snapshot.root}</span></>}</div>
    {error && <p role="alert" className="mb-2 whitespace-pre-wrap text-[#A8741F]">{error}</p>}
    <div data-plugin-keyboard ref={element} className="min-h-0 flex-1 overflow-hidden rounded border border-[#E5E8EC] p-2" />
  </div>;
}
