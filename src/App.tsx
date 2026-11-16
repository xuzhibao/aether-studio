import { MotionConfig } from "motion/react";
import { PluginsDialog } from "./components/PluginsDialog";
import { plugins } from "./plugins/runtime";
import { useEffect } from "react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { AgentPanel } from "./components/AgentPanel";
import { CommandPalette } from "./components/CommandPalette";
import { DeployDialog, NewProjectDialog } from "./components/Dialogs";
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
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <Workspace />
          <AgentPanel />
        </div>
        <StatusBar />
        <CommandPalette />
        <PluginsDialog />
        <NewProjectDialog />
        <DeployDialog />
        <DevicesDialog />
        <TestsDialog />
        <ProjectOverviewDialog />
        <Toasts />
      </div>
    </TooltipProvider></MotionConfig>
  );
}
