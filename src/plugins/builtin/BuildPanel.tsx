import { useEffect } from "react";
import { useDisk, isActionCancelled } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { isDesktop } from "../../lib/desktop";
export default function BuildPanel() {
  const disk = useDisk(); const setDialog = useStudio((s) => s.setDialog); const openFile = useStudio((s) => s.openFile);
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error) => {
      // The user closed the pre-build review: report it, but do not present a cancelled build as a failure.
      if (isActionCancelled(error)) { useStudio.getState().addToast({ title: "已取消构建", detail: (error as Error).message, tone: "default" }); return; }
      useDisk.setState({ error: String(error) });
    });
  };
  useEffect(() => { if (disk.root) run(() => disk.loadEnvironments()); }, [disk.root]);
  return <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-white p-5 text-[11px] text-[#59616A]">
    <h1 className="text-base font-semibold">Build Tasks</h1><p className="mt-2 break-all">{disk.root || "尚未打开磁盘工程目录"}</p>
    <p className="mt-2 leading-5 text-[#90969E]">构建执行本机 PlatformIO，并运行工程中声明的构建脚本。使用已保存文件；运行期间的编辑需另行保存并重新构建。成功仅表示构建完成，不代表固件已运行或烧录。</p>
    <p className="mt-2 leading-5 text-[#90969E]">当前环境来自 platformio.ini，构建、上传和生成编译数据库都使用它；任务运行期间不能切换。</p>
    <p className="mt-2 leading-5 text-[#90969E]">构建或上传前会核对 platformio.ini、当前环境的分区表和所选环境。发现变化时只把该环境的旧分区产物移出 `.pio/build/环境名`（不删除，其他环境不受影响），避免继续烧录旧分区表；没有变化时不会清理缓存。</p>
    <p className="mt-2 leading-5 text-[#90969E]">如果磁盘上的 platformio.ini 或分区表被外部修改，构建前会逐文件显示差异：纯外部修改可一键重新读取并继续，冲突文件需明确选择保留哪一版，取消不会创建任务或烧录。</p>
    <div className="my-2 flex flex-wrap items-center gap-2"><label htmlFor="build-environment">PlatformIO 环境</label><select id="build-environment" data-build-environment={disk.environment} className="rounded border border-[#E5E8EC] bg-white px-2 py-1" disabled={!disk.root || !disk.environments.length || disk.starting || disk.tasks.some((task) => task.status === "running")} value={disk.environment} onChange={(event) => run(async () => disk.setEnvironment(event.target.value))}>{disk.environments.map((item) => <option key={item.name} value={item.name}>{item.name}{item.default ? "（默认）" : ""}</option>)}</select><button className="btn px-2 py-1" disabled={!disk.root || disk.starting || disk.tasks.some((task) => task.status === "running")} onClick={() => run(() => disk.loadEnvironments())}>Refresh environments</button>{disk.root && !disk.environments.length && <span>platformio.ini 中没有可用环境</span>}</div>
    <div className="my-3 flex flex-wrap gap-2"><button className="btn px-3 py-1.5" disabled={disk.busy || disk.starting} onClick={() => run(disk.open)}>Open project folder</button><button className="btn px-3 py-1.5" disabled={disk.busy || disk.starting} onClick={() => run(disk.saveAs)}>Save project to folder</button><button className="btn btn-primary px-3 py-1.5" disabled={!disk.root || disk.starting || disk.tasks.some((task) => task.status === "running")} onClick={() => run(() => disk.build("platformio.build"))}>Build with PlatformIO</button><button className="btn px-3 py-1.5" disabled={!disk.root || disk.starting || disk.tasks.some((task) => task.status === "running")} onClick={() => run(() => disk.build("platformio.compiledb"))}>Generate compilation database</button><button className="btn px-3 py-1.5" onClick={() => setDialog("plugins")}>Plugins</button></div>
    {disk.error && <p role="alert" className="mb-3 text-[#A8741F]">{disk.error}</p>}
    {disk.tasks.slice().reverse().map((task) => <section data-task-provider={task.provider} key={task.id} className="mb-4 min-w-0 rounded-lg border border-[#E5E8EC] p-3">
      <div className="flex items-center gap-2"><strong>{task.provider}</strong><span role="status" data-task-status={task.status}>{task.status}</span><span>exit {task.exitCode ?? "—"}</span>{task.status === "running" && <button className="btn ml-auto px-2 py-1" onClick={() => run(() => disk.cancel(task.id))}>Cancel task</button>}</div>
      <p className="mt-2 break-all text-[10px]">{task.toolVersion} · {task.root}{task.environment ? " · env " + task.environment : ""}</p><p className="mt-1 break-all font-mono text-[9px]">Input SHA-256: {task.inputHash}</p>
      {task.error && <p role="alert" className="mt-2 text-[#A8741F]">{task.error}</p>}
      <pre className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap rounded bg-[#F8F9FB] p-2 font-mono text-[10px] leading-5">{task.log}</pre>
      {task.artifacts.map((artifact) => <div key={artifact.path} className="mt-2 break-all font-mono text-[9px]">{artifact.path} · {artifact.size} bytes · SHA-256 {artifact.sha256}</div>)}
    </section>)}
    {!isDesktop() && <p>浏览器仅提供工作区预览；真实文件和构建需要 Electron 桌面端。</p>}
  </div>;
}
