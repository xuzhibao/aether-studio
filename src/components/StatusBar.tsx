import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Sparkles,
  Usb,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn, formatElapsed } from "../lib/utils";

export function StatusBar() {
  const {
    runState,
    elapsed,
    errors,
    warnings,
    addToast,
    pauseSimulation,
    runSimulation,
    setTab,
    setDockTab,
    setDockOpen,
    agentRunning,
    agentCollapsed,
  } = useStudio();

  return (
    <footer className="flex h-[28px] flex-none items-center gap-2 border-t border-[#E5E8EC] bg-[#F8F9FA] px-3 text-[9.5px] text-[#6F757D]">
      <button
        className="flex items-center gap-1.5 font-medium text-[#4B5158] hover:text-[#1D1D1F]"
        onClick={() => (runState === "running" ? pauseSimulation() : runSimulation())}
      >
        <span className={cn("h-[5px] w-[5px] rounded-full", runState === "running" ? "bg-[#2B9661] pulse-dot" : "bg-[#C08A2E]")} />
        {runState === "running" ? "Demo Simulation Running" : "Demo Simulation Idle"}
      </button>
      <span className="font-mono text-[9px] tabular text-[#767D85]">{formatElapsed(elapsed)}</span>
      <span className="h-[11px] w-px bg-[#DFE2E6]" />
      <span className="flex items-center gap-1"><Cpu size={10} className="text-[#878D95]" /> ESP32-S3 <span className="text-[#B8BCC2]">·</span> MicroPython</span>
      <span className="h-[11px] w-px bg-[#DFE2E6]" />
      <button className="flex items-center gap-1 hover:text-[#1D1D1F]" onClick={() => { setDockOpen(true); setDockTab("console"); }}>
        <CheckCircle2 size={10} className="text-[#2B9661]" /> {errors} Errors
        <span className="mx-0.5 text-[#B8BCC2]">·</span>
        <span className="flex items-center gap-1 text-[#986C1F]"><AlertTriangle size={10} /> {warnings} Warnings</span>
      </button>
      <span className="h-[11px] w-px bg-[#DFE2E6]" />
      <button className="flex items-center gap-1 hover:text-[#1D1D1F]" onClick={() => setTab("serial")}>
        <Usb size={10} className="text-[#7C838B]" /> Demo output · 无真实设备
      </button>

      <span className="flex-1" />

      <button className="hidden items-center gap-1.5 text-[#7D848D] hover:text-[#3F454C] min-[1300px]:flex" onClick={() => addToast({ title: "Agent session", detail: agentRunning ? "Aether is executing a task." : "配置 API 后可发送工程问答。", tone: "default" })}>
        <Sparkles size={9.5} className={agentRunning ? "text-[#007AFF]" : "text-[#8A9098]"} />
        {agentRunning ? "Agent working" : agentCollapsed ? "Agent collapsed" : "Agent · Ask"}
      </button>
      <span className="mx-0.5 hidden h-[11px] w-px bg-[#DFE2E6] min-[1300px]:block" />
      <span className="hidden tabular text-[#9CA1A8] min-[1200px]:inline">100%</span>
      <span className="hidden text-[#C0C4CA] min-[1200px]:inline">·</span>
      <span className="hidden text-[#9CA1A8] min-[1200px]:inline">UTF-8</span>
      <span className="hidden text-[#C0C4CA] min-[1200px]:inline">·</span>
      <span className="hidden text-[#9CA1A8] min-[1200px]:inline">Spaces: 4</span>
    </footer>
  );
}
