import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircuitBoard,
  Cpu,
  FileCode2,
  Hammer,
  History,
  LoaderCircle,
  Mic,
  Moon,
  MoreHorizontal,
  Paperclip,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Wand2,
  X,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import type { AgentMessage, AgentRef, Step } from "../types";
import { ResizeDivider } from "./ResizeDivider";
import { IconButton, Spinner, Tip } from "./ui";

function Orb({ size = 25 }: { size?: number }) {
  return (
    <div
      className="agent-orb relative flex flex-none items-center justify-center rounded-full"
      style={{ width: size, height: size }}
    >
      <Sparkles size={size * 0.5} strokeWidth={1.6} className="text-white/90" />
      <span className="absolute right-[2px] top-[2px] h-[5px] w-[5px] rounded-full border border-[#1b1f24] bg-[#4EA6FF]" />
    </div>
  );
}

function StepIcon({ state }: { state: Step["state"] }) {
  if (state === "done") {
    return (
      <span className="step-icon bg-[#EAF6EF] text-[#2B9661]">
        <Check size={9} strokeWidth={2.6} />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="step-icon bg-[#EAF3FF] text-[#007AFF]">
        <LoaderCircle size={9.5} strokeWidth={2.2} className="spin-slow" />
      </span>
    );
  }
  return (
    <span className="step-icon border border-[#E1E4E8] bg-white text-[#C0C4CA]">
      <Circle size={3} fill="currentColor" strokeWidth={0} />
    </span>
  );
}

function Refs({ refs }: { refs: AgentRef[] }) {
  const { openFile, setTab, selectComponent, addToast } = useStudio();
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {refs.map((ref) => {
        const isFile = ref.kind === "file";
        return (
          <button
            key={ref.label}
            className="agent-ref"
            onClick={() => {
              if (isFile && ref.target) openFile(ref.target);
              else if (ref.kind === "part" && ref.target) {
                setTab("circuit");
                selectComponent(ref.target);
              } else addToast({ title: ref.label, detail: ref.meta ?? "Pin inspected by the agent", tone: "default" });
            }}
          >
            {isFile ? <FileCode2 size={10.5} className="text-[#4E7CA6]" /> : <Cpu size={10.5} className="text-[#68737F]" />}
            <span className="font-mono text-[9.5px] text-[#424850]">{ref.label}</span>
            {ref.meta && (
              <span className={cn("text-[8px]", ref.meta.startsWith("+") ? "text-[#2B9661]" : "text-[#9AA0A8]")}>{ref.meta}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function LiveStrip() {
  return (
    <div className="mt-2.5 flex items-center gap-2 rounded-[7px] border border-[#E7EEF6] bg-[#F8FBFF] px-2.5 py-[7px]">
      <span className="h-[5px] w-[5px] flex-none rounded-full bg-[#2B9661] pulse-dot" />
        <div className="min-w-0 flex-1">
        <div className="text-[9.5px] font-medium text-[#4E5C6B]">Monitoring serial output</div>
        <div className="mt-[1px] text-[8.5px] text-[#7F8894]">2.0 s cadence · 0 anomalies · COM3</div>
      </div>
      <svg width="43" height="15" viewBox="0 0 43 15" fill="none" className="flex-none opacity-70">
        <path d="M1 10 L5 8 L9 10 L13 5 L17 7 L21 4 L25 8 L29 3 L33 6 L37 5 L42 7" stroke="#4C92D8" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function Message({ message }: { message: AgentMessage }) {
  const { runAgent, applyFix, appliedFixIds, agentRunning } = useStudio();
  const [expanded, setExpanded] = useState(true);
  const applied = appliedFixIds.includes(message.id);

  if (message.role === "user") {
    return (
      <div className="mt-4 first:mt-0">
        <div className="mb-1 flex items-center justify-end gap-1.5 pr-0.5">
          <span className="text-[8.5px] font-medium text-[#9AA0A8]">You</span>
          <span className="text-[8.5px] tabular text-[#B6BAC0]">{message.time}</span>
        </div>
        <div className="agent-user">{message.text}</div>
      </div>
    );
  }

  const active = message.steps?.some((s) => s.state === "active");
  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5">
        <Orb size={17} />
        <span className="text-[10.5px] font-semibold text-[#2B2F35]">Aether</span>
        <span className="rounded-[3px] bg-[#F0F2F5] px-1 py-[1px] text-[7.5px] font-semibold uppercase tracking-[0.05em] text-[#8A9099]">Agent</span>
        <span className="ml-auto text-[8.5px] tabular text-[#B2B6BC]">{message.time}</span>
      </div>
      <p className="mt-1.5 select-text text-[12px] leading-[1.62] text-[#383D44]">{message.text}</p>

      {expanded && message.steps && message.steps.length > 0 && (
        <div className="mt-2.5 rounded-[8px] border border-[#EAEDF1] bg-[#FCFCFD] px-2.5 pb-1.5 pt-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="label-caps text-[8px] text-[#9CA2A9]">Execution</span>
            <span className={cn("ml-auto flex items-center gap-1 text-[8px]", active ? "text-[#007AFF]" : "text-[#2B9661]")}>
              {active ? <LoaderCircle size={8.5} className="spin-slow" /> : <Check size={8.5} />}
              {active ? "In progress" : "Complete"}
            </span>
          </div>
          <div>
            {message.steps.map((step, i) => (
              <div key={step.id} className="relative flex gap-2 pb-[9px] last:pb-1">
                {i < message.steps!.length - 1 && <span className="step-line" />}
                <StepIcon state={step.state} />
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-[10.5px] leading-[1.45]",
                      step.state === "active" ? "shimmer font-medium" : step.state === "done" ? "text-[#3C4249]" : "text-[#9AA0A8]",
                    )}
                  >
                    {step.label}
                  </div>
                  {step.detail && <div className="mt-[1px] font-mono text-[8px] leading-[1.4] text-[#A0A6AE]">{step.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {expanded && message.refs && message.refs.length > 0 && (
        <div>
          <div className="mt-2.5 flex items-center gap-1">
            <span className="label-caps text-[8px] text-[#A3A8AF]">Artifacts</span>
            <span className="text-[8px] text-[#A3A8AF]">· {message.refs.length} items</span>
          </div>
          <Refs refs={message.refs} />
        </div>
      )}

      {expanded && message.summary && (
        <p className="mt-2.5 select-text text-[11px] leading-[1.63] text-[#5B6169]">{message.summary}</p>
      )}

      {message.actions && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            className="btn h-[25px] gap-1.5 px-2 text-[9.5px] text-[#4B525A]"
            onClick={() => {
              const firstFile = message.refs?.find((r) => r.kind === "file");
              useStudio.getState().openFile(firstFile?.target ?? "main.py");
            }}
          >
            <FileCode2 size={10.5} /> View Changes
          </button>
          <button
            className={cn(
              "btn h-[25px] gap-1.5 px-2 text-[9.5px]",
              applied ? "border-[#D8EDE1] bg-[#EFF8F3] text-[#2B7F58]" : "border-[#CBE0F9] bg-[#EDF5FF] text-[#0068D6] hover:bg-[#E4F0FF]",
            )}
            onClick={() => applyFix(message.id)}
            disabled={applied}
          >
            {applied ? <Check size={10.5} /> : <Wand2 size={10.5} />}
            {applied ? "Fix Applied" : "Apply Fix"}
          </button>
        </div>
      )}

      {message.live && <LiveStrip />}
    </div>
  );
}

function Suggestions() {
  const { runAgent, agentRunning } = useStudio();
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1 text-[8px] text-[#8E959D]">
        <Sparkles size={8.5} /> Suggested next
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button className="flex h-[24px] items-center gap-1.5 rounded-[5.5px] border border-[#E5E8EC] bg-white px-2 text-[9.5px] text-[#5C636B] hover:border-[#D3D9E0] hover:bg-[#F8FAFC]" disabled={agentRunning} onClick={() => runAgent("Add a deep-sleep schedule to reduce power between samples.")}>
          <Moon size={10} className="text-[#7F8B98]" /> Add deep-sleep mode
        </button>
        <button className="flex h-[24px] items-center gap-1.5 rounded-[5.5px] border border-[#E5E8EC] bg-white px-2 text-[9.5px] text-[#5C636B] hover:border-[#D3D9E0] hover:bg-[#F8FAFC]" disabled={agentRunning} onClick={() => runAgent("Explain how the I2C wiring works and why GPIO 8 and 9 were chosen.")}>
          <CircuitBoard size={10} className="text-[#7F8B98]" /> Explain the I²C wiring
        </button>
      </div>
    </div>
  );
}

export function AgentPanel() {
  const {
    agentWidth,
    setAgentWidth,
    agentCollapsed,
    setAgentCollapsed,
    agentMessages,
    agentRunning,
    agentDraft,
    setAgentDraft,
    runAgent,
    addToast,
  } = useStudio();
  const [mode, setMode] = useState("Build & Debug");
  const [model, setModel] = useState("Hardware Agent");
  const [listening, setListening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [agentMessages, agentRunning]);

  if (agentCollapsed) {
    return (
      <div className="flex flex-none">
        <div className="flex w-[38px] flex-col items-center gap-2 border-l border-[#E9EBEE] bg-[#FCFCFD] py-3">
          <Tip label="Open Aether Agent" side="left">
            <button onClick={() => setAgentCollapsed(false)} className="group relative">
              <Orb size={24} />
            </button>
          </Tip>
          <div className="mt-1 flex flex-col items-center gap-3">
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.12em] text-[#A0A5AC]" style={{ writingMode: "vertical-rl" }}>Aether Agent</span>
            <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
          </div>
          <Tip label="New session" side="left">
            <button className="mt-auto flex h-6 w-6 items-center justify-center rounded-[5px] text-[#8E949C] hover:bg-[#F0F2F4]" onClick={() => setAgentCollapsed(false)}>
              <Plus size={13} />
            </button>
          </Tip>
        </div>
      </div>
    );
  }

  const submit = () => {
    if (agentRunning) return;
    if (!agentDraft.trim()) {
      inputRef.current?.focus();
      addToast({ title: "Describe a change", detail: "Tell Aether what to build, modify or debug.", tone: "default" });
      return;
    }
    runAgent();
  };

  return (
    <div className="flex flex-none">
      <ResizeDivider axis="x" value={agentWidth} min={316} max={470} reverse onChange={setAgentWidth} />
      <aside className="flex h-full flex-none flex-col border-l border-[#E9EBEE] bg-[#FCFCFD]" style={{ width: agentWidth }}>
        <div className="flex-none border-b border-[#ECEEF1] px-3 pb-2 pt-2.5">
          <div className="flex items-center gap-2">
            <Orb size={27} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-semibold tracking-[-0.01em] text-[#22262B]">Aether Agent</span>
                <span className={cn("flex h-[15px] items-center gap-1 rounded-[3.5px] px-1.5 text-[7.5px] font-semibold uppercase tracking-[0.04em]", agentRunning ? "bg-[#EDF5FF] text-[#2F6BAE]" : "bg-[#EBF6EF] text-[#2B7F58]")}>
                  <span className={cn("h-[3px] w-[3px] rounded-full", agentRunning ? "bg-[#007AFF] pulse-dot" : "bg-[#2B9661]")} />
                  {agentRunning ? "Working" : "Ready"}
                </span>
              </div>
              <div className="mt-[2px] flex items-center gap-1 text-[8.5px] text-[#858C94]">
                <span className="h-[3px] w-[3px] rounded-full bg-[#B9BEC5]" />
                Autonomous engineering
              </div>
            </div>
            <IconButton label="Collapse agent" className="h-[24px] w-[24px]" onClick={() => setAgentCollapsed(true)}>
              <X size={12.5} />
            </IconButton>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="icon-btn h-[24px] w-[24px]">
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="end" sideOffset={6} className="menu-content w-[224px]">
                <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.setState({ agentMessages: [] })}>
                  <RotateCcw size={12} /> New session
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.setState({ agentMessages: [] })}>
                  <History size={12} /> Clear conversation
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.getState().addToast({ title: "Agent settings", detail: "Tool permissions: circuit, firmware, simulation.", tone: "default" })}>
                  <Settings2 size={12} /> Agent permissions
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.getState().addToast({ title: "No active run", detail: "Aether is idle and watching the simulation.", tone: "default" })}>
                  <Square size={11} /> Stop current run
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex h-[23px] items-center gap-1 rounded-[5px] border border-[#E4E7EB] bg-white px-1.5 text-[9px] font-medium text-[#545B63] hover:bg-[#F8F9FA]">
                  <Hammer size={10} className="text-[#7A828B]" />
                  {mode}
                  <ChevronDown size={8} className="text-[#A2A7AE]" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" sideOffset={5} className="menu-content w-[196px]">
                <div className="menu-label">Agent mode</div>
                {["Build & Debug", "Plan", "Review", "Ask"].map((item) => (
                  <DropdownMenu.Item key={item} className="menu-item" onSelect={() => setMode(item)}>
                    <Hammer size={12} className="text-[#818991]" /> {item}
                    {mode === item && <Check size={11} className="ml-auto text-[#007AFF]" />}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex h-[23px] items-center gap-1 rounded-[5px] border border-[#E4E7EB] bg-white px-1.5 text-[9px] font-medium text-[#545B63] hover:bg-[#F8F9FA]">
                  <Cpu size={10} className="text-[#7A828B]" />
                  {model}
                  <ChevronDown size={8} className="text-[#A2A7AE]" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" sideOffset={5} className="menu-content w-[214px]">
                <div className="menu-label">Model</div>
                {["Hardware Agent", "Fast Tool Use", "Deep Reasoning"].map((item) => (
                  <DropdownMenu.Item key={item} className="menu-item" onSelect={() => { setModel(item); useStudio.getState().addToast({ title: "Agent model", detail: item + " selected for this session.", tone: "default" }); }}>
                    <Sparkles size={11} className="text-[#818991]" /> {item}
                    {model === item && <Check size={11} className="ml-auto text-[#007AFF]" />}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <span className="ml-auto flex items-center gap-1 text-[8px] tabular text-[#8F969E]">
              <span className="h-[3px] w-[3px] rounded-full bg-[#2B9661]" /> 4 tools
            </span>
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px flex-1 bg-[#ECEEF1]" />
            <span className="text-[8px] font-medium text-[#B0B4BB]">Today · 12:04</span>
            <span className="h-px flex-1 bg-[#ECEEF1]" />
          </div>

          {agentMessages.length === 0 ? (
            <div className="mt-12 flex flex-col items-center px-6 text-center">
              <Orb size={44} />
              <div className="mt-3 text-[12px] font-semibold text-[#33383E]">What should we build?</div>
              <p className="mt-1 text-[10px] leading-[1.6] text-[#8F959D]">Aether can edit the circuit, write firmware, run the simulator and deploy to hardware.</p>
            </div>
          ) : (
            agentMessages.map((message) => <Message key={message.id} message={message} />)
          )}

          {!agentRunning && agentMessages.length > 0 && <Suggestions />}
          <div className="h-2" />
        </div>

        <div className="flex-none border-t border-[#E9EBEE] bg-[#FCFCFD] px-3 pb-3 pt-2">
          <div className="mb-1.5 flex items-center gap-1">
            <span className="mr-0.5 text-[8px] font-medium text-[#AAAEB5]">Context</span>
            <span className="flex h-[18px] items-center gap-1 rounded-[4px] bg-[#F1F3F6] px-1.5 text-[8px] text-[#6D747C]"><CircuitBoard size={8.5} /> Circuit</span>
            <span className="flex h-[18px] items-center gap-1 rounded-[4px] bg-[#F1F3F6] px-1.5 text-[8px] text-[#6D747C]"><FileCode2 size={8.5} /> main.py</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] text-[#A0A5AC] hover:bg-[#F1F3F6] hover:text-[#666D75]">
                  <Plus size={10} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" sideOffset={5} className="menu-content w-[218px]">
                <div className="menu-label">Add context</div>
                {["sensors.py", "config.json", "Serial output", "Full project"].map((item) => (
                  <DropdownMenu.Item key={item} className="menu-item" onSelect={() => useStudio.getState().addToast({ title: "Context attached", detail: item + " added to this request.", tone: "default" })}>
                    <FileCode2 size={11} className="text-[#818991]" /> {item}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>

          <div className="agent-composer px-2.5 pb-1.5 pt-2">
            <textarea
              value={agentDraft}
              onChange={(e) => setAgentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              ref={inputRef}
              placeholder="Ask Aether to build, modify or debug…"
              className="max-h-[90px] min-h-[32px] w-full resize-none bg-transparent text-[10.5px] leading-[1.55] text-[#343940] outline-none placeholder:text-[#A8ADB4]"
            />
            <div className="flex items-center gap-0.5 pt-1">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="flex h-[23px] w-[23px] items-center justify-center rounded-[5px] text-[#8A9098] hover:bg-[#F2F4F6] hover:text-[#545B63]">
                    <Plus size={12.5} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" side="top" sideOffset={6} className="menu-content w-[206px]">
                  <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.getState().addToast({ title: "Context added", detail: "Circuit graph attached to the next message.", tone: "default" })}>
                    <CircuitBoard size={12} /> Attach circuit
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.getState().addToast({ title: "Pin state added", detail: "GPIO 8, GPIO 9, GPIO 2 attached.", tone: "default" })}>
                    <Cpu size={12} /> Attach pin state
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
              <button className="flex h-[23px] w-[23px] items-center justify-center rounded-[5px] text-[#8A9098] hover:bg-[#F2F4F6] hover:text-[#545B63]" onClick={() => fileRef.current?.click()}>
                <Paperclip size={12} />
              </button>
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => { if (e.target.files?.[0]) useStudio.getState().addToast({ title: "File attached", detail: e.target.files[0].name + " will be available to Aether.", tone: "success" }); e.target.value = ""; }} />
              <button
                className={cn("flex h-[23px] w-[23px] items-center justify-center rounded-[5px] hover:bg-[#F2F4F6]", listening ? "bg-[#FDF0EE] text-[#D15345]" : "text-[#8A9098] hover:text-[#545B63]")}
                onClick={() => {
                  if (listening) return;
                  setListening(true);
                  useStudio.getState().addToast({ title: "Listening…", detail: "Speak your engineering request.", tone: "default" });
                  window.setTimeout(() => {
                    setListening(false);
                    if (!useStudio.getState().agentDraft) setAgentDraft("Check the I2C warning and verify the sensor still samples at 2 seconds.");
                    useStudio.getState().addToast({ title: "Voice captured", detail: "Transcript added to the composer.", tone: "success" });
                  }, 1700);
                }}
              >
                {listening ? <span className="h-[7px] w-[7px] rounded-full bg-[#D15345] pulse-dot" /> : <Mic size={12} />}
              </button>
              <span className="ml-auto mr-2 hidden items-center gap-1 text-[8px] text-[#9AA0A8] min-[1500px]:flex">⌘↵ to run</span>
              <button
                onClick={submit}
                disabled={agentRunning}
                className="flex h-[24px] items-center gap-1.5 rounded-[5.5px] bg-[#007AFF] px-2 text-[9.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,84,178,0.24)] transition-colors hover:bg-[#006FE8] disabled:bg-[#C9D9EA] disabled:text-white/80 disabled:shadow-none"
              >
                {agentRunning ? <Spinner size={10} /> : <ArrowUp size={11} strokeWidth={2.2} />}
                {agentRunning ? "Working" : "Run"}
              </button>
            </div>
          </div>
          <div className="mt-1.5 flex items-center justify-center gap-1 text-[8px] text-[#939AA2]">
            <Sparkles size={7.5} /> Aether can edit files and hardware · Review before deploying
          </div>
        </div>
      </aside>
    </div>
  );
}
