import { useLanguage } from "../../store/language";
import { useDisk } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { usePlugins } from "../usePlugins";
import { isDesktop } from "../../lib/desktop";
export default function LanguagePanel() {
  const provider = usePlugins().require("languages", "clangd");
  const { snapshot, error } = useLanguage(); const root = useDisk((state) => state.root);
  const run = (action: () => Promise<unknown>) => { void action().catch((error) => useLanguage.setState({ error: String(error) })); };
  const start = async () => { if (!root) throw new Error("请先打开磁盘工程"); useLanguage.setState({ error: "" }); await provider.start(root); };
  return <div className="min-w-0 flex-1 overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="text-base font-semibold">C/C++ Language</h1>
    <p className="mt-2 leading-6">clangd 分析已打开的 C/C++ 缓冲区，诊断不等于实际编译结果。Ctrl+Space 补全，悬停查看说明，F12 跳转工程内定义。请先生成编译数据库，再启动或重启语言服务。</p>
    <div className="my-3 flex flex-wrap gap-2"><button className="btn px-3 py-1.5" disabled={!isDesktop() || !root} onClick={() => run(start)}>Start clangd</button><button className="btn px-3 py-1.5" disabled={!isDesktop() || !root} onClick={() => run(async () => { await provider.stop(); await start(); })}>Restart clangd</button><button className="btn px-3 py-1.5" disabled={!snapshot || snapshot.status !== "ready"} onClick={() => run(() => provider.stop())}>Stop clangd</button></div>
    <p role="status" data-language-status={snapshot?.status ?? "idle"}>{snapshot ? `clangd · ${snapshot.status}` : "尚未启动 clangd"}</p>
    {snapshot && <><p className="mt-2 break-all">{snapshot.root}</p><p className="mt-2 break-all">clangd 可执行文件：{snapshot.executable}</p><p className="mt-2">{snapshot.compileDatabase ? "启动时已找到 compile_commands.json" : "启动时未找到编译数据库，使用 clangd 默认参数；诊断可能不准确。"}</p></>}
    {error && <p role="alert" className="mt-3 whitespace-pre-wrap text-[#A8741F]">{error}</p>}
    {!isDesktop() && <p className="mt-3">语言服务需要 Electron 桌面端和本机 clangd。</p>}
    <h2 className="mt-5 font-semibold">打开文件的诊断</h2>
    {snapshot?.documents.flatMap((document) => document.diagnostics.map((diagnostic, index) => <button key={document.file + index} className="mt-2 block w-full rounded border border-[#E5E8EC] p-3 text-left" onClick={() => { useLanguage.setState({ jump: { file: document.file, range: diagnostic.range } }); useStudio.getState().openFile(document.file); }}><span className="font-mono">{document.file}:{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}</span><span className="ml-3">{diagnostic.severity === 1 ? "Error" : diagnostic.severity === 2 ? "Warning" : "Info"}</span><p className="mt-2 whitespace-pre-wrap">{diagnostic.message}</p></button>))}
    <details className="mt-4"><summary>clangd 日志</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{snapshot?.log || "无日志"}</pre></details>
  </div>;
}
