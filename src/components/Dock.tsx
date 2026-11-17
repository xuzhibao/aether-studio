import { useTransport } from "../store/transport";
import { useEffect, useState } from "react";
import {
  Activity,
  Braces,
  ChevronDown,
  FileCode2,
  Gauge,
  Terminal,
  Trash2,
} from "lucide-react";
import { useStudio } from "../store/studio";
import type { DockTab } from "../types";
import { cn } from "../lib/utils";
import { ResizeDivider } from "./ResizeDivider";
import { SerialList } from "./SerialLines";
import { Tip } from "./ui";

const tabs: Array<{ id: DockTab; label: string; icon: typeof Terminal }> = [
  { id: "code", label: "Code", icon: FileCode2 },
  { id: "serial", label: "Serial Monitor", icon: Activity },
  { id: "console", label: "Console", icon: Terminal },
  { id: "variables", label: "Variables", icon: Braces },
  { id: "logic", label: "Logic Analyzer", icon: Activity },
  { id: "performance", label: "Performance", icon: Gauge },
];

function CodePreview() {
  const { files, openFile, activeTab, openTabs } = useStudio();
  const candidates = [activeTab, ...[...openTabs].reverse(), ...Object.keys(files)];
  const file = candidates.find((file) => file !== "circuit.json" && Object.hasOwn(files, file));
  if (!file) return <div className="p-3 text-[10px] text-[#68717A]">尚无文件</div>;
  return <div data-code-preview={file} className="flex h-full flex-col"><button className="border-b border-[#EEF0F3] px-3 py-1 text-left text-[10px] text-[#68717A]" onClick={() => openFile(file)}>{file} · 点击编辑</button><pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[10px] leading-5 text-[#59616A]">{files[file]}</pre></div>;
}

function VariablesPane() {
  const { readings, elapsed, ledOn, cpu } = useStudio();
  const vars = [
    { name: "reading.temperature", type: "float", value: readings.temperature.toFixed(1) + " °C", scope: "Demo Simulation", changed: true },
    { name: "reading.humidity", type: "float", value: readings.humidity.toFixed(1) + " %", scope: "Demo Simulation", changed: true },
    { name: "reading.pressure", type: "float", value: readings.pressure.toFixed(1) + " hPa", scope: "Demo Simulation", changed: false },
    { name: "sample", type: "int", value: String(Math.floor(elapsed / 2)), scope: "Demo Simulation", changed: true },
    { name: "led.value()", type: "Pin", value: ledOn ? "1" : "0", scope: "Demo Simulation", changed: true },
    { name: "i2c.freq", type: "int", value: "Demo only", scope: "global", changed: false },
    { name: "heap_free", type: "int", value: "未采集", scope: "system", changed: false },
    { name: "cpu_load", type: "float", value: "未采集", scope: "system", changed: true },
  ];
  return (
    <div className="flex h-full flex-col px-2 py-1">
      <div className="grid grid-cols-[1.6fr_0.6fr_1fr_1.20fr] gap-1 border-b border-[#EEF0F3] px-2 pb-1 text-[8px] font-semibold uppercase tracking-[0.06em] text-[#A2A7AE]">
        <span>Name</span><span>Type</span><span>Value</span><span>Scope</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {vars.map((v) => (
          <div key={v.name} className="grid h-[19px] grid-cols-[1.6fr_0.6fr_1fr_1.20fr] items-center gap-1 rounded-[3px] px-2 font-mono text-[9px] hover:bg-[#F6F8FA]">
            <span className="truncate text-[#434A52]">{v.name}</span>
            <span className="text-[#9AA0A8]">{v.type}</span>
            <span className={cn("tabular", v.changed ? "text-[#2F6FA8]" : "text-[#5E666F]")}>{v.value}</span>
            <span className="truncate text-[8.5px] text-[#AAAEB5]">{v.scope}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dock() {
  const {
    dockOpen,
    dockHeight,
    setDockHeight,
    dockTab,
    setDockTab,
    runState,
    serial,
    console: consoleLines,
    warnings,
    errors,
    setDockOpen,
    addToast,
  } = useStudio();
  const [follow, setFollow] = useState(true);
  const io = useTransport();
  const [serialSource, setSerialSource] = useState<"demo" | "device">(() => io.status === "connected" ? "device" : "demo");
  useEffect(() => { if (io.status === "connected") setSerialSource("device"); }, [io.status]);
  if (!dockOpen) return null;

  const clear = () => {
    if (dockTab === "serial") { if (serialSource === "demo") useStudio.setState({ serial: [] }); else io.clear(); }
    else if (dockTab === "console") useStudio.setState({ console: [] });
    else addToast({ title: "Nothing to clear", tone: "default" });
  };

  return (
    <div className="relative flex flex-none flex-col border-t border-[#E9EBEE] bg-[#FCFCFD]" style={{ height: dockHeight }}>
      <ResizeDivider axis="y" value={dockHeight} min={128} max={360} reverse onChange={setDockHeight} />
      <div className="flex h-[31px] flex-none items-center gap-0.5 border-b border-[#EDEFF2] px-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} className={cn("dock-tab", dockTab === tab.id && "active")} onClick={() => setDockTab(tab.id)}>
              <Icon size={10.5} strokeWidth={1.8} className={dockTab === tab.id ? "text-[#5B636C]" : "text-[#A0A5AD]"} />
              {tab.label}
            </button>
          );
        })}
        <div className="ml-auto flex flex-none items-center gap-1.5">
          {dockTab === "serial" && <select aria-label="Dock serial source" value={serialSource} onChange={(event) => setSerialSource(event.target.value as typeof serialSource)} className="bg-transparent text-[9px]"><option value="demo">Demo Simulation</option><option value="device">Device transport</option></select>}
          {(dockTab === "serial" || dockTab === "console") && (
            <>
              <button className="flex h-[20px] items-center gap-1 rounded-[4px] px-1.5 text-[8.5px] text-[#8A9098] hover:bg-[#F0F2F4]" onClick={() => setFollow(!follow)}>
                <span className={cn("h-[3.5px] w-[3.5px] rounded-full", follow ? "bg-[#2B9661]" : "bg-[#B9BDC4]")} /> Follow
              </button>
              <Tip label="Clear output" side="top">
                <button className="flex h-[20px] w-[20px] items-center justify-center rounded-[4px] text-[#9399A1] hover:bg-[#F0F2F4]" onClick={clear}>
                  <Trash2 size={11} />
                </button>
              </Tip>
            </>
          )}
          <Tip label="Close panel" side="top">
            <button className="flex h-[20px] w-[20px] items-center justify-center rounded-[4px] text-[#9399A1] hover:bg-[#F0F2F4]" onClick={() => setDockOpen(false)}>
              <ChevronDown size={12} />
            </button>
          </Tip>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 pt-0.5">
        {dockTab === "code" && (
          <>
            <div className="min-w-0 flex-[1.6] border-r border-[#EEF0F3]">
              <CodePreview />
            </div>
            <div className="flex min-w-0 flex-1 flex-col bg-[#FBFBFC]">
              <div className="flex h-[25px] flex-none items-center gap-1.5 border-b border-[#F0F2F4] px-2.5">
                <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
                <span className="text-[9px] font-medium text-[#5D646C]">Demo Output</span>
                <span className="text-[8.5px] text-[#A6ABB2]">Demo Simulation</span>
                <button className="ml-auto pr-1 text-[9px] font-medium text-[#68717A] hover:text-[#007AFF]" onClick={() => setDockTab("serial")}>
                  Expand
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <SerialList lines={serial.slice(-7)} compact follow={false} showIcons={false} />
              </div>
            </div>
          </>
        )}
        {dockTab === "serial" && (
          <div className="min-h-0 flex-1">
            <SerialList lines={serialSource === "demo" ? serial : io.lines} compact follow={follow} />
          </div>
        )}
        {dockTab === "console" && (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
            {consoleLines.map((line) => (
              <div key={line.id} className="flex h-[19px] items-center gap-2 rounded-[3px] px-1.5 font-mono text-[9.5px] hover:bg-[#F5F7F9]">
                <span className="w-[54px] flex-none text-right text-[8px] font-semibold uppercase tracking-[0.04em] text-[#A2A7AE]">{line.source}</span>
                <span className={cn("h-[2px] w-[2px] rounded-full", line.tone === "success" ? "bg-[#3B9A68]" : line.tone === "warn" ? "bg-[#C08A2E]" : "bg-[#C4C8CD]")} />
                <span className={cn("truncate", line.tone === "muted" ? "text-[#969CA4]" : line.tone === "success" ? "text-[#2B7F58]" : "text-[#4A515A]")}>{line.text}</span>
              </div>
            ))}
            {consoleLines.length === 0 && <div className="flex h-full items-center justify-center text-[10px] text-[#9AA0A8]">Console is clear.</div>}
          </div>
        )}
        {dockTab === "variables" && <div className="min-h-0 flex-1"><VariablesPane /></div>}
        {dockTab === "logic" && <div className="p-4 text-xs text-[#8A9098]">逻辑分析仪尚未实现。</div>}
        {dockTab === "performance" && <div className="p-4 text-xs text-[#8A9098]">真实性能采集尚未实现。</div>}
      </div>
    </div>
  );
}

