import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  Check,
  ChevronDown,
  Clock3,
  Cloud,
  CornerDownLeft,
  Cpu,
  Pause,
  Play,
  Search,
  Send,
  Trash2,
  Usb,
  Wifi,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn, formatElapsed, simTime, uid } from "../lib/utils";
import { SerialList } from "./SerialLines";
import { IconButton, Tip } from "./ui";

const bauds = ["9600", "57600", "115200", "230400", "921600"];

export function SerialWorkspace() {
  const {
    serial,
    elapsed,
    runState,
    readings,
    errors,
    warnings,
    addToast,
    setRunState,
    pauseSimulation,
    runSimulation,
  } = useStudio();
  const [filter, setFilter] = useState<"all" | "data" | "warn">("all");
  const [query, setQuery] = useState("");
  const [pausedStream, setPausedStream] = useState(false);
  const [baud, setBaud] = useState("115200");
  const [command, setCommand] = useState("");

  const lines = serial.filter((line) => line.text.toLowerCase().includes(query.toLowerCase()));
  const displayed = pausedStream ? lines.slice(0, lines.length) : lines;

  const sendCommand = () => {
    const value = command.trim();
    if (!value) return;
    const entry = {
      id: uid("s"),
      time: simTime(elapsed),
      level: "data" as const,
      text: ">>> " + value,
    };
    useStudio.setState((s) => ({ serial: [...s.serial, entry].slice(-90) }));
    setCommand("");
    window.setTimeout(() => {
      useStudio.setState((s) => ({
        serial: [
          ...s.serial,
          { id: uid("s"), time: simTime(s.elapsed, 120), level: "success" as const, text: "OK · command accepted by REPL" },
        ].slice(-90),
      }));
    }, 320);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#FCFCFD]">
      <div className="flex h-[48px] flex-none items-center gap-2.5 border-b border-[#E9EBEE] px-3.5">
        <div className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] bg-[#F0F4F9] text-[#47617D] shadow-[inset_0_0_0_0.5px_rgba(20,24,33,0.06)]">
          <Activity size={14} strokeWidth={1.8} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-[#24282D]">Serial Monitor</span>
            <span className={cn("flex h-[16px] items-center gap-1 rounded-[4px] px-1.5 text-[8.5px] font-medium", runState === "running" ? "bg-[#EBF6EF] text-[#2B7F58]" : "bg-[#FBF3E3] text-[#9A6C1D]")}>
              <span className={cn("h-[4px] w-[4px] rounded-full", runState === "running" ? "bg-[#2B9661]" : "bg-[#C08A2E]")} />
              {runState === "running" ? "Streaming" : "Paused"}
            </span>
          </div>
          <div className="mt-[1px] text-[9px] text-[#969CA4]">Virtual ESP32-S3 · USB Serial/JTAG · {formatElapsed(elapsed)} uptime</div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="btn btn-sm h-[25px] gap-1 text-[10px] text-[#4B525A]">
                {baud} baud <ChevronDown size={9} className="text-[#9AA0A8]" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={5} className="menu-content w-[150px]">
              {bauds.map((rate) => (
                <DropdownMenu.Item key={rate} className="menu-item" onSelect={() => { setBaud(rate); addToast({ title: "Baud rate changed", detail: rate + " · COM3 reconnected", tone: "default" }); }}>
                  <span className="font-mono text-[10px]">{rate}</span>
                  {baud === rate && <Check size={11} className="ml-auto text-[#007AFF]" />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <IconButton label={runState === "running" ? "Pause simulation" : "Resume simulation"} onClick={() => (runState === "running" ? pauseSimulation() : runSimulation())}>
          {runState === "running" ? <Pause size={12.5} fill="currentColor" strokeWidth={0} /> : <Play size={12.5} fill="currentColor" strokeWidth={0} />}
        </IconButton>
        <Tip label={pausedStream ? "Resume console" : "Pause console"}>
          <button className={cn("icon-btn", pausedStream && "is-active")} onClick={() => setPausedStream(!pausedStream)}>
            {pausedStream ? <Play size={13} /> : <Pause size={13} />}
          </button>
        </Tip>
        <Tip label="Clear serial output">
          <button className="icon-btn" onClick={() => { useStudio.setState({ serial: [] }); addToast({ title: "Serial cleared", detail: "New output will continue streaming.", tone: "default" }); }}>
            <Trash2 size={13} />
          </button>
        </Tip>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[33px] flex-none items-center gap-2 border-b border-[#F0F2F4] px-3">
            <div className="seg">
              {[["all", "All"], ["data", "Data"], ["warn", "Warnings"]].map(([id, label]) => (
                <button key={id} className={cn("seg-item h-[20px]", filter === id && "active")} onClick={() => setFilter(id as typeof filter)}>
                  {label}
                  {id === "warn" && warnings > 0 && <span className="text-[8px] text-[#C08A2E]">{warnings}</span>}
                </button>
              ))}
            </div>
            <div className="ml-auto flex h-[23px] w-[190px] items-center gap-1.5 rounded-[5px] border border-[#E7EAEE] bg-[#FAFBFC] px-2">
              <Search size={10.5} className="text-[#A2A7AE]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter output…" className="w-full bg-transparent text-[9.5px] text-[#454B52] outline-none placeholder:text-[#AFB3BA]" />
            </div>
            <span className="tabular text-[8.5px] text-[#A0A5AC]">{displayed.length} lines</span>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden bg-white">
            <SerialList lines={displayed} filter={filter} follow={!pausedStream} />
            {!pausedStream && (
              <div className="pointer-events-none absolute bottom-[86px] left-3 flex items-center gap-1.5 text-[8px] text-[#B0B4BB]">
                <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661] pulse-dot" /> Following output
              </div>
            )}
          </div>

          <div className="flex h-[38px] flex-none items-center gap-2 border-t border-[#E9EBEE] bg-[#FAFBFC] px-3">
            <span className="font-mono text-[10px] font-medium text-[#007AFF]">&gt;&gt;&gt;</span>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendCommand(); }}
              placeholder="Send a MicroPython command to the board…"
              className="h-full flex-1 bg-transparent font-mono text-[10px] text-[#3B4148] outline-none placeholder:font-sans placeholder:text-[#ADB2B9]"
            />
            <span className="hidden items-center gap-1 text-[8.5px] text-[#AFB3BA] min-[1200px]:flex">
              <CornerDownLeft size={9} /> Enter to send
            </span>
            <button className="btn h-[24px] gap-1 px-2 text-[9px] text-[#4B525A]" onClick={sendCommand} disabled={!command.trim()}>
              <Send size={9.5} /> Send
            </button>
          </div>
        </div>

        <aside className="hidden w-[236px] flex-none flex-col border-l border-[#E9EBEE] bg-[#FAFBFC] min-[1260px]:flex">
          <div className="flex h-[33px] items-center justify-between border-b border-[#EEF0F3] px-3">
            <span className="label-caps">Connection</span>
            <span className="flex items-center gap-1 text-[8.5px] text-[#2B9661]"><span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />Online</span>
          </div>
          <div className="px-3 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] bg-white text-[#536170] shadow-[0_0_0_0.5px_rgba(20,24,33,0.08),0_1px_2px_rgba(20,24,33,0.04)]"><Usb size={14} /></span>
              <div>
                <div className="text-[10px] font-[560] text-[#353A41]">ESP32-S3 DevKitC-1</div>
                <div className="mt-[1px] text-[8.5px] text-[#99A0A8]">USB Serial/JTAG · COM3</div>
              </div>
            </div>

            <div className="mt-3 space-y-[7px]">
              {[
                [<Cpu key="c" size={10} />, "Firmware", "MicroPython 1.23"],
                [<Clock3 key="t" size={10} />, "Uptime", formatElapsed(elapsed)],
                [<Wifi key="w" size={10} />, "Wi-Fi", "AetherLab · −48 dBm"],
                [<Cloud key="m" size={10} />, "MQTT", "QoS 1 · 42 ms"],
              ].map(([icon, label, value]) => (
                <div key={label as string} className="flex items-center gap-2 text-[9px]">
                  <span className="text-[#989EA6]">{icon}</span>
                  <span className="w-[48px] text-[#969CA4]">{label}</span>
                  <span className="ml-auto text-right font-medium text-[#4A5159]">{value}</span>
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-[6px] border border-[#EDEFF2] bg-white p-2">
              <div className="flex items-center justify-between text-[8px] text-[#9AA0A8]">
                <span>Serial throughput</span>
                <span className="tabular text-[#5F666E]">62 B/s</span>
              </div>
              <svg viewBox="0 0 190 36" className="mt-1.5 h-[36px] w-full" preserveAspectRatio="none">
                <path d="M0 28 L10 24 L20 27 L30 18 L40 22 L50 15 L60 20 L70 12 L80 17 L90 9 L100 14 L110 8 L120 15 L130 6 L140 12 L150 10 L160 17 L170 11 L180 16 L190 13 L190 36 L0 36 Z" fill="#E9F3FF" />
                <path d="M0 28 L10 24 L20 27 L30 18 L40 22 L50 15 L60 20 L70 12 L80 17 L90 9 L100 14 L110 8 L120 15 L130 6 L140 12 L150 10 L160 17 L170 11 L180 16 L190 13" fill="none" stroke="#4C92D8" strokeWidth="1" />
              </svg>
              <div className="flex justify-between text-[7.5px] tabular text-[#B0B4BB]"><span>30 s</span><span>now</span></div>
            </div>

            <div className="mt-3 space-y-1.5 border-t border-[#ECEEF1] pt-2.5">
              <div className="flex justify-between text-[8.5px]"><span className="text-[#969CA4]">Last sample</span><span className="tabular text-[#4E555D]">{readings.temperature.toFixed(1)} °C</span></div>
              <div className="flex justify-between text-[8.5px]"><span className="text-[#969CA4]">Errors</span><span className="tabular text-[#4E555D]">{errors}</span></div>
              <div className="flex justify-between text-[8.5px]"><span className="text-[#969CA4]">Warnings</span><span className="tabular text-[#A8741F]">{warnings}</span></div>
            </div>
          </div>
          <div className="mt-auto border-t border-[#ECEEF1] px-3 py-2">
            <button className="flex h-[25px] w-full items-center justify-center gap-1.5 rounded-[5px] border border-[#E1E4E8] bg-white text-[9px] font-medium text-[#5A6169] hover:bg-[#F7F8FA]" onClick={() => addToast({ title: "Device manager", detail: "COM3 is the active virtual serial port.", tone: "default" })}>
              <Usb size={10} /> Manage connection
            </button>
          </div>
        </aside>
      </div>
    </div>
    </div>
  );
}
