import { useLanguage } from "../../store/language";
import { useDisk } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { usePlugins } from "../usePlugins";
import { isDesktop } from "../../lib/desktop";
const databaseLabel = { missing: "未生成（使用 clangd 默认参数）", ready: "已就绪（使用根目录 compile_commands.json）", stale: "已过期（需要重新生成）" } as const;
export default function LanguagePanel() {
  const provider = usePlugins().require("languages", "clangd");
  const { snapshot, error, queryDriver, setQueryDriver } = useLanguage(); const root = useDisk((state) => state.root);
  const environment = useDisk((state) => state.environment);
  const run = (action: () => Promise<unknown>) => { void action().catch((error) => useLanguage.setState({ error: String(error) })); };
  const start = async () => { if (!root) throw new Error("请先打开磁盘工程"); useLanguage.setState({ error: "" }); await provider.start(root); };
  const restart = async () => { if (!root) throw new Error("请先打开磁盘工程"); useLanguage.setState({ error: "" }); if (snapshot?.status === "ready" && provider.restart) await provider.restart(); else await start(); };
  const toggleQueryDriver = (value: boolean) => {
    useLanguage.getState().setQueryDriver(value);
    // A running process reads its flags at startup; restart it while keeping the open buffers.
    if (snapshot?.status === "ready" && provider.restart) run(() => provider.restart!());
  };
  return <div className="min-w-0 flex-1 overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="text-base font-semibold">C/C++ Language</h1>
    <p className="mt-2 leading-6">clangd 分析已打开的 C/C++ 缓冲区，诊断不等于实际编译结果。Ctrl+Space 补全，悬停查看说明，F12 跳转工程内定义。编译数据库由 PlatformIO 的 Generate compilation database 任务按当前环境生成；成功后语言服务会自动重启并重新载入未保存的缓冲区，不需要重开目录。</p>
    <div className="my-3 flex flex-wrap gap-2"><button className="btn px-3 py-1.5" disabled={!isDesktop() || !root} onClick={() => run(start)}>Start clangd</button><button className="btn px-3 py-1.5" disabled={!isDesktop() || !root} onClick={() => run(restart)}>Restart clangd</button><button className="btn px-3 py-1.5" disabled={!snapshot || snapshot.status !== "ready"} onClick={() => run(() => provider.stop())}>Stop clangd</button></div>
    <p role="status" data-language-status={snapshot?.status ?? "idle"}>{snapshot ? `clangd · ${snapshot.status}` : "尚未启动 clangd"}</p>
    {snapshot && <><p className="mt-2 break-all">{snapshot.root}</p><p className="mt-2 break-all">clangd 可执行文件：{snapshot.executable}</p><p className="mt-2" data-language-environment={snapshot.environment}>环境：{snapshot.environment || "未选择（未使用 PlatformIO 环境）"}</p><p className="mt-2" data-language-database={snapshot.compileDatabase}>编译数据库：{databaseLabel[snapshot.compileDatabase]}</p>{snapshot.compileDatabaseMessage && <p className="mt-2 whitespace-pre-wrap text-[#A8741F]">{snapshot.compileDatabaseMessage}</p>}</>}
    <div className="mt-3 rounded border border-[#E5E8EC] p-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={queryDriver} onChange={(event) => toggleQueryDriver(event.target.checked)} />允许 clangd 运行当前环境解析出的编译器（--query-driver）</label>
      <p className="mt-2 leading-5 text-[#90969E]">默认关闭。编译器路径只在 Generate compilation database 任务成功时由 PlatformIO 解析并缓存到 `.aether/compiledb.json`；启动语言服务只读缓存，不运行 PlatformIO 或工程脚本。启用后只把 PlatformIO 核心 packages 目录内的字面路径传给 clangd，不使用通配符，也不会执行工程外的任意编译器。没有缓存时请重新生成编译数据库。当前会话允许的路径：</p>
      <ul className="mt-1 font-mono text-[10px]">{snapshot?.queryDrivers.length ? snapshot.queryDrivers.map((item) => <li key={item} className="break-all">{item}</li>) : <li>{queryDriver ? "启动后显示解析结果；没有符合条件的编译器时保持为空。" : "未启用。"}</li>}</ul>
    </div>
    {snapshot && <details className="mt-3"><summary>clangd 启动参数</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">{snapshot.args.join("\n")}</pre></details>}
    <p className="mt-2 text-[#90969E]">当前选择的 PlatformIO 环境：{environment || "未加载"}。切换环境不会复用旧环境的编译数据库或旧诊断。</p>
    {error && <p role="alert" className="mt-3 whitespace-pre-wrap text-[#A8741F]">{error}</p>}
    {!isDesktop() && <p className="mt-3">语言服务需要 Electron 桌面端和本机 clangd。</p>}
    <h2 className="mt-5 font-semibold">打开文件的诊断</h2>
    {snapshot?.documents.flatMap((document) => document.diagnostics.map((diagnostic, index) => <button key={document.file + index} className="mt-2 block w-full rounded border border-[#E5E8EC] p-3 text-left" onClick={() => { useLanguage.setState({ jump: { file: document.file, range: diagnostic.range } }); useStudio.getState().openFile(document.file); }}><span className="font-mono">{document.file}:{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}</span><span className="ml-3">{diagnostic.severity === 1 ? "Error" : diagnostic.severity === 2 ? "Warning" : "Info"}</span><p className="mt-2 whitespace-pre-wrap">{diagnostic.message}</p></button>))}
    <details className="mt-4"><summary>clangd 日志</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{snapshot?.log || "无日志"}</pre></details>
  </div>;
}
