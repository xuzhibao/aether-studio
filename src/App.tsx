import { connectDesktop, useDisk } from "./store/disk";
import { ReviewChangesDialog } from "./components/ReviewChangesDialog";
import { MotionConfig } from "motion/react";
import { PluginsDialog } from "./components/PluginsDialog";
import { plugins } from "./plugins/runtime";
import { useEffect } from "react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { AgentPanel } from "./components/AgentPanel";
import { CommandPalette } from "./components/CommandPalette";
import { DeployDialog, NewFileDialog, NewProjectDialog } from "./components/Dialogs";
import { DevicesDialog } from "./components/DevicesDialog";
import { ProjectOverviewDialog } from "./components/ProjectOverviewDialog";
import { TestsDialog } from "./components/TestsDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { Workspace } from "./components/Workspace";
import { useStudio } from "./store/studio";

export default function App() {
  useEffect(() => connectDesktop(), []);
  const disk = useDisk();
  const tick = useStudio((s) => s.tick);
  const reducedMotion = useStudio((s) => s.settings.reducedMotion);
  useEffect(() => { document.documentElement.dataset.reducedMotion = String(reducedMotion); }, [reducedMotion]);

  useEffect(() => {
    const timer = window.setInterval(() => tick(), 1000);
    return () => window.clearInterval(timer);
  }, [tick]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const mod = event.metaKey || event.ctrlKey;
      const s = useStudio.getState();
      if (useDisk.getState().busy) { event.preventDefault(); return; }

      if (target?.closest("[data-plugin-keyboard]")) return;

      const shortcut = [mod ? "mod" : "", event.shiftKey ? "shift" : "", event.key.toLowerCase()].filter(Boolean).join("+");
      const command = plugins.all("commands").find((c) => c.shortcut === shortcut);
      if (command) {
        event.preventDefault();
        void Promise.resolve().then(command.run).catch((error) => s.addToast({ title: "插件命令失败", detail: String(error), tone: "warn" }));
        return;
      }
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        s.setCommandOpen(!s.commandOpen);
        return;
      }
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        s.saveProject();
        return;
      }
      if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        s.build();
        return;
      }
      if (mod && event.key.toLowerCase() === "j") {
        event.preventDefault();
        s.setAgentCollapsed(!s.agentCollapsed);
        return;
      }
      if (mod && event.key === "\\") {
        event.preventDefault();
        s.setSidebarCollapsed(!s.sidebarCollapsed);
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        s.setDialog("new-project");
        return;
      }
      if (mod && event.key.toLowerCase() === "r") {
        event.preventDefault();
        s.runSimulation();
        return;
      }
      if (typing || mod) return;
      if (event.key.toLowerCase() === "v" && s.activeTab === "circuit") s.setTool("select");
      if (event.key.toLowerCase() === "w" && s.activeTab === "circuit") s.setTool("wire");
      if (event.key.toLowerCase() === "a" && s.activeTab === "circuit") { s.setTool("add"); s.setLibraryOpen(true); }
      if (event.key.toLowerCase() === "i" && s.activeTab === "circuit") { s.setTool("inspect"); s.selectComponent(s.selectedId ?? "board-1"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}><TooltipProvider delayDuration={380} skipDelayDuration={180}>
      <div className="app-shell">
        {disk.busy && <div role="status" className="fixed inset-0 z-[200] flex items-center justify-center bg-white/60 text-sm text-[#59616A]">正在处理工程目录…</div>}
        <TopBar />
        {disk.root && <div className="flex flex-none items-center gap-2 border-b border-[#E9EBEE] bg-white px-3 py-1 text-[10px]"><span className="min-w-0 flex-1 truncate" title={disk.root}>{disk.root}</span>{disk.changed && <><span className="text-[#A8741F]">目录有外部变更</span><button className="btn px-2" disabled={disk.busy} onClick={() => { const command = plugins.get("commands", "project.files.changes"); if (!command) { void disk.reload().catch((error) => useDisk.setState({ error: String(error) })); return; } void Promise.resolve().then(command.run).catch((error) => useStudio.getState().addToast({ title: "无法打开磁盘变更", detail: String(error), tone: "warn" })); }}>按文件处理…</button></>}<button className="btn px-2" disabled={disk.busy} onClick={() => { void disk.reload().catch((error) => useDisk.setState({ error: String(error) })); }}>重新读取（放弃未保存修改）</button></div>}
        {disk.error && <div role="alert" className="flex gap-2 bg-[#FFF5E7] px-3 py-1 text-[11px] text-[#9A702C]">{disk.error}<button className="ml-auto" onClick={() => useDisk.setState({ error: "" })}>关闭</button></div>}
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <Workspace />
          <AgentPanel />
        </div>
        <StatusBar />
        <CommandPalette />
        <ReviewChangesDialog />
        <PluginsDialog />
        <NewProjectDialog />
        <NewFileDialog />
        <DeployDialog />
        <DevicesDialog />
        <TestsDialog />
        <ProjectOverviewDialog />
        {plugins.all("dialogs").map((dialog) => { const Render = dialog.render; return <Render key={dialog.id} />; })}
        <Toasts />
      </div>
    </TooltipProvider></MotionConfig>
  );
}
