import { useState } from "react";
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

function Tok({ c, children }: { c: string; children: React.ReactNode }) {
  return <span style={{ color: c }}>{children}</span>;
}

function CodePreview() {
  const { openFile, aiModifiedFiles } = useStudio();
  const lines: Array<{ n: number; content: React.ReactNode; ai?: boolean }> = [
    { n: 18, content: <><Tok c="#9B3FA6">def</Tok> <Tok c="#2C6E7E">read_environment</Tok>():</> },
    { n: 19, content: <><Tok c="#3A4048">    reading</Tok> = <Tok c="#3A4048">sensor</Tok>.<Tok c="#2C6E7E">read</Tok>()</> },
    { n: 20, content: <><Tok c="#9B3FA6">    return</Tok> {"{"}</> },
    { n: 21, content: <>        <Tok c="#B04B3E">"temperature"</Tok>: reading.temperature,</>, ai: true },
    { n: 22, content: <>        <Tok c="#B04B3E">"humidity"</Tok>: reading.humidity,</>, ai: true },
    { n: 23, content: <>        <Tok c="#B04B3E">"pressure"</Tok>: reading.pressure,</>, ai: true },
    { n: 24, content: <>    {"}"}</> },
    { n: 25, content: <></> },
    { n: 26, content: <><Tok c="#9B3FA6">def</Tok> <Tok c="#2C6E7E">render</Tok>(data):</> },
    { n: 27, content: <>    display.<Tok c="#2C6E7E">fill</Tok>(<Tok c="#4B5CB0">0</Tok>)</> },
    { n: 28, content: <>    display.<Tok c="#2C6E7E">text</Tok>(<Tok c="#B04B3E">"ENV MONITOR"</Tok>, <Tok c="#4B5CB0">0</Tok>, <Tok c="#4B5CB0">0</Tok>)</> },
    { n: 29, content: <>    display.<Tok c="#2C6E7E">show</Tok>()</> },
  ];
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-[25px] flex-none items-center gap-1.5 border-b border-[#F0F2F4] px-2.5">
        <FileCode2 size={10.5} className="text-[#4C7EA8]" />
        <span className="font-mono text-[9px] text-[#5A6169]">main.py</span>
        {aiModifiedFiles.includes("main.py") && (
          <span className="flex items-center gap-1 rounded-[3px] bg-[#EDF5FF] px-1 py-[1px] text-[8px] font-medium text-[#2F6BAE]">
            <span className="h-[3px] w-[3px] rounded-full bg-[#007AFF]" /> Aether
          </span>
        )}
        <button className="ml-auto text-[8.5px] font-medium text-[#7C838B] hover:text-[#007AFF]" onClick={() => openFile("main.py")}>
          Open Editor
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {lines.map((line) => (
          <div key={line.n} className={cn("flex h-[17px] items-center font-mono text-[10px] leading-[17px]", line.ai && "bg-[#F6FAFF]")}>
            <div className={cn("mr-2.5 h-full w-[2px]", line.ai ? "bg-[#7FB9F5]" : "bg-transparent")} />
            <span className="w-[27px] flex-none pr-3 text-right text-[9px] tabular text-[#B4B9C0]">{line.n}</span>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre text-[#3D434A]">{line.content}</span>
          </div>
        ))}
      </div>
      <div className="flex h-[21px] flex-none items-center gap-1.5 border-t border-[#F0F2F4] bg-[#FBFCFD] px-2.5 text-[8px] text-[#8F969F]">
        <span className="h-[3px] w-[3px] rounded-full bg-[#2B9661]" />
        3 Aether edits · verified
        <span className="ml-auto">UTF-8</span>
      </div>
    </div>
  );
}

function VariablesPane() {
  const { readings, elapsed, ledOn, cpu } = useStudio();
  const vars = [
    { name: "reading.temperature", type: "float", value: readings.temperature.toFixed(1) + " °C", scope: "read_environment()", changed: true },
    { name: "reading.humidity", type: "float", value: readings.humidity.toFixed(1) + " %", scope: "read_environment()", changed: true },
    { name: "reading.pressure", type: "float", value: readings.pressure.toFixed(1) + " hPa", scope: "read_environment()", changed: false },
    { name: "sample", type: "int", value: String(Math.floor(elapsed / 2)), scope: "main()", changed: true },
    { name: "led.value()", type: "Pin", value: ledOn ? "1" : "0", scope: "main()", changed: true },
    { name: "i2c.freq", type: "int", value: "400000", scope: "global", changed: false },
    { name: "heap_free", type: "int", value: "214.4 KB", scope: "system", changed: false },
    { name: "cpu_load", type: "float", value: cpu.toFixed(1) + " %", scope: "system", changed: true },
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

function LogicPane() {
  const { runState } = useStudio();
  const scl = "M0 46 H34 V18 H70 V46 H104 V18 H142 V46 H178 V18 H216 V46 H252 V18 H290 V46 H326 V18 H364 V46 H402 V18 H440 V46 H478 V18 H516 V46 H556 V18 H594 V46 H634 V18 H676 V46";
  const sda = "M0 84 H34 V56 H60 V84 H92 V56 H118 V84 H152 V56 H178 V84 H200 V56 H224 V84 H260 V56 H290 V84 H318 V56 H346 V84 H376 V56 H404 V84 H432 V56 H464 V84 H498 V56 H532 V84 H560 V56 H594 V84 H626 V56 H660 V84 H700";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[22px] flex-none items-center gap-3 border-b border-[#F0F2F4] px-2.5 text-[8.5px] text-[#9AA0A8]">
        <span className="flex items-center gap-1"><span className="h-[4px] w-[4px] rounded-full bg-[#2F7FD8]" /> SDA · GPIO 8</span>
        <span className="flex items-center gap-1"><span className="h-[4px] w-[4px] rounded-full bg-[#D9962F]" /> SCL · GPIO 9</span>
        <span className="ml-auto tabular">400 kHz · 30 ms window</span>
        <span className="flex items-center gap-1 text-[#2B9661]"><span className={cn("h-[4px] w-[4px] rounded-full bg-[#2B9661]", runState === "running" && "pulse-dot")} />Triggered</span>
      </div>
      <div className="relative min-h-0 flex-1 px-2 pb-1 pt-1">
        <svg viewBox="0 0 720 110" preserveAspectRatio="none" className="h-full w-full">
          {[16, 38, 60, 82, 104].map((y) => <line key={y} x1="0" y1={y} x2="720" y2={y} stroke="#F0F2F4" strokeWidth="0.7" />)}
          {[0, 90, 180, 270, 360, 450, 540, 630].map((x) => <line key={x} x1={x} y1="0" x2={x} y2="110" stroke="#F6F7F9" strokeWidth="0.7" />)}
          <path d={scl} fill="none" stroke="#D9962F" strokeWidth="1.15" opacity="0.9" />
          <path d={sda} fill="none" stroke="#2F7FD8" strokeWidth="1.15" opacity="0.9" />
          <line x1="622" y1="4" x2="622" y2="108" stroke="#007AFF" strokeWidth="0.8" strokeDasharray="2 2" opacity="0.6" />
          <circle cx="622" cy="44" r="2.4" fill="#007AFF" />
        </svg>
        <div className="pointer-events-none absolute left-3 top-2 flex flex-col gap-[22px] text-[8px] font-medium text-[#90969E]">
          <span>SCL</span>
          <span>SDA</span>
        </div>
        <div className="pointer-events-none absolute bottom-1 right-3 flex gap-3 text-[7.5px] tabular text-[#B0B4BB]">
          <span>0 ms</span><span>10</span><span>20</span><span>30 ms</span>
        </div>
      </div>
    </div>
  );
}

function PerformancePane() {
  const { cpu, memory } = useStudio();
  return (
    <div className="grid h-full grid-cols-[1.45fr_1fr] gap-2 px-2.5 py-2">
      <div className="flex flex-col justify-between py-0.5">
        {[
          ["CPU load", cpu + "%", "#5B9EDD", cpu],
          ["Heap in use", memory * 2.4 + " KB", "#6BAF85", 42],
          ["Loop time", "1.8 ms", "#B99655", 31],
        ].map(([label, value, color, pct]) => (
          <div key={label as string} className="flex items-center gap-3">
            <span className="w-[64px] text-[8.5px] text-[#92989F]">{label}</span>
            <span className="w-[48px] text-[9.5px] font-medium tabular text-[#3F454C]">{value}</span>
            <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-[#EFF1F4]">
              <span className="block h-full rounded-full" style={{ width: pct + "%", background: color as string }} />
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-col rounded-[5px] border border-[#EEF0F3] bg-[#FBFCFD] px-2 py-1.5">
        <div className="flex items-center justify-between text-[8px] text-[#9BA0A8]">
          <span>CPU · last 30 s</span>
          <span className="tabular">avg 38%</span>
        </div>
        <svg viewBox="0 0 160 42" className="mt-auto h-[42px] w-full" preserveAspectRatio="none">
          <path d="M0 34 L10 28 L20 31 L30 22 L40 26 L50 18 L60 24 L70 16 L80 21 L90 13 L100 20 L110 12 L120 18 L130 10 L140 16 L150 9 L160 14 L160 42 L0 42 Z" fill="#EAF2FB" />
          <path d="M0 34 L10 28 L20 31 L30 22 L40 26 L50 18 L60 24 L70 16 L80 21 L90 13 L100 20 L110 12 L120 18 L130 10 L140 16 L150 9 L160 14" fill="none" stroke="#5B9EDD" strokeWidth="1" />
        </svg>
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
  if (!dockOpen) return null;

  const clear = () => {
    if (dockTab === "serial") useStudio.setState({ serial: [] });
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
                <span className="text-[9px] font-medium text-[#5D646C]">Live Serial</span>
                <span className="text-[8.5px] text-[#A6ABB2]">COM3 · 115200</span>
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
            <SerialList lines={serial} compact follow={follow} />
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
        {dockTab === "logic" && <div className="min-h-0 flex-1"><LogicPane /></div>}
        {dockTab === "performance" && <div className="min-h-0 flex-1"><PerformancePane /></div>}
      </div>
    </div>
  );
}

