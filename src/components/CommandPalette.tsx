import { useTransport } from "../store/transport";
import { usePlugins } from "../plugins/usePlugins";
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowUpToLine,
  Box,
  Columns2,
  FileCode2,
  FileJson,
  FlaskConical,
  FolderPlus,
  Hammer,
  Lightbulb,
  Maximize2,
  Monitor,
  PanelLeft,
  Pause,
  Play,
  Radio,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Terminal,
  Thermometer,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { Kbd } from "./ui";

interface Command {
  id: string;
  label: string;
  group: string;
  icon: typeof Play;
  shortcut?: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const { commandOpen, setCommandOpen, addToast } = useStudio();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const registry = usePlugins();
  const revision = registry.getRevision();
  const commands = useMemo<Command[]>(() => {
    const s = () => useStudio.getState();
    return [
      { id: "plugins", label: "Manage Plugins", group: "Workspace", icon: Box, run: () => s().setDialog("plugins") },
      ...registry.all("commands").map((command) => ({ id: command.id, label: command.name, group: "Plugins", icon: Box, run: () => { void Promise.resolve().then(command.run).catch((error) => s().addToast({ title: "插件命令失败", detail: String(error), tone: "warn" })); } })),
      { id: "run", label: "Run Demo Simulation", group: "Simulation", icon: Play, shortcut: "⌘R", run: () => s().runSimulation() },
      { id: "pause", label: "Pause simulation", group: "Simulation", icon: Pause, run: () => s().pauseSimulation() },
      { id: "reset", label: "Reset virtual board", group: "Simulation", icon: RotateCcw, run: () => s().resetSimulation() },
      { id: "build", label: "Check project files (not compile)", group: "Simulation", icon: Hammer, shortcut: "⌘B", run: () => s().build() },
      { id: "deploy", label: "Deploy to device", group: "Simulation", icon: ArrowUpToLine, run: () => s().setDialog("deploy") },
      { id: "serial", label: "Open Serial Monitor", group: "Navigate", icon: Terminal, run: () => s().setTab("serial") },
      { id: "main", label: "Open main.py", group: "Navigate", icon: FileCode2, run: () => s().openFile("main.py") },
      { id: "sensors", label: "Open sensors.py", group: "Navigate", icon: FileCode2, run: () => s().openFile("sensors.py") },
      { id: "circuit", label: "Open circuit.json", group: "Navigate", icon: FileJson, run: () => s().openFile("circuit.json") },
      { id: "split", label: "Split circuit with editor", group: "Navigate", icon: Columns2, run: () => { s().setTab("circuit"); s().setSplitMode(true); } },
      { id: "fit", label: "Fit canvas to view", group: "Canvas", icon: Maximize2, run: () => s().resetView() },
      { id: "schematic", label: "Switch to schematic view", group: "Canvas", icon: Box, run: () => s().setViewMode("schematic") },
      { id: "bme", label: "Add BME280 sensor", group: "Components", icon: Thermometer, run: () => s().addComponent("bme280") },
      { id: "oled", label: "Add OLED display", group: "Components", icon: Monitor, run: () => s().addComponent("oled") },
      { id: "led", label: "Add status LED", group: "Components", icon: Lightbulb, run: () => s().addComponent("led") },
      { id: "agent", label: "Toggle Aether Agent", group: "Workspace", icon: Sparkles, shortcut: "⌘J", run: () => s().setAgentCollapsed(!s().agentCollapsed) },
      { id: "sidebar", label: "Toggle project sidebar", group: "Workspace", icon: PanelLeft, shortcut: "⌘\\", run: () => s().setSidebarCollapsed(!s().sidebarCollapsed) },
      { id: "save", label: "Save workspace", group: "Workspace", icon: Save, shortcut: "⌘S", run: () => s().saveProject() },
      { id: "new", label: "Create new project", group: "Project", icon: FolderPlus, shortcut: "⇧⌘N", run: () => s().setDialog("new-project") },
      { id: "overview", label: "Project overview", group: "Project", icon: Box, run: () => s().setDialog("overview") },
      { id: "disconnect-transport", label: "Disconnect device transport", group: "Project", icon: Radio, run: () => { void useTransport.getState().disconnect(); } },
      { id: "devices", label: "Manage devices", group: "Project", icon: Radio, run: () => s().setDialog("devices") },
      { id: "tests", label: "Open test reports", group: "Project", icon: FlaskConical, run: () => s().setDialog("tests") },
    ];
  }, [revision]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (c.label + " " + c.group + " " + (c.hint ?? "")).toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query, commandOpen]);

  useEffect(() => {
    if (!commandOpen) setQuery("");
  }, [commandOpen]);

  const groups = useMemo(() => {
    const map = new Map<string, Command[]>();
    filtered.forEach((command) => {
      const list = map.get(command.group) ?? [];
      list.push(command);
      map.set(command.group, list);
    });
    return Array.from(map.entries());
  }, [filtered]);

  const execute = (command: Command | undefined) => {
    if (!command) return;
    setCommandOpen(false);
    window.setTimeout(() => command.run(), 30);
  };

  let runningIndex = -1;

  return (
    <Dialog.Root open={commandOpen} onOpenChange={setCommandOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="fixed left-1/2 top-[12%] z-[100] w-[584px] max-w-[calc(100vw-60px)] -translate-x-1/2 overflow-hidden rounded-[12px] bg-[#FDFDFE]/98 shadow-[0_0_0_0.5px_rgba(20,24,33,0.14),0_34px_90px_-18px_rgba(20,24,33,0.38),0_4px_14px_rgba(20,24,33,0.08)] backdrop-blur-2xl"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(filtered.length - 1, i + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              execute(filtered[active]);
            }
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">Search and run Aether Studio commands.</Dialog.Description>
          <div className="flex h-[48px] items-center gap-2.5 border-b border-[#ECEEF1] px-3.5">
            <Search size={15} className="text-[#8C929A]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands, files and actions…"
              className="h-full flex-1 bg-transparent text-[12px] text-[#2B3036] outline-none placeholder:text-[#A6ABB2]"
            />
            <Kbd>esc</Kbd>
          </div>

          <div className="max-h-[388px] overflow-y-auto p-1.5">
            {groups.map(([group, items]) => (
              <div key={group} className="mb-0.5">
                <div className="px-2 pb-1 pt-2 text-[8px] font-semibold uppercase tracking-[0.07em] text-[#A3A8AF]">{group}</div>
                {items.map((command) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const Icon = command.icon;
                  return (
                    <button
                      key={command.id}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => execute(command)}
                      className={cn(
                        "flex h-[31px] w-full items-center gap-2.5 rounded-[6px] px-2 text-left text-[11px]",
                        active === index ? "bg-[#EDF5FF] text-[#185C9E]" : "text-[#40464D] hover:bg-[#F5F7F9]",
                      )}
                    >
                      <Icon size={13} strokeWidth={1.75} className={active === index ? "text-[#2F7DCE]" : "text-[#8B919A]"} />
                      <span className={cn("font-[450]", active === index && "font-medium")}>{command.label}</span>
                      {command.hint && <span className="ml-1 text-[9px] text-[#A6ABB2]">{command.hint}</span>}
                      {command.shortcut && (
                        <span className="ml-auto flex items-center gap-1">
                          {command.shortcut.split("").map((char, i) => (
                            <kbd key={i} className={cn("rounded-[3.5px] border px-1 py-[1px] text-[8px] leading-[12px]", active === index ? "border-[#CFE0F4] bg-white/80 text-[#6A87A6]" : "border-[#E5E8EC] bg-[#F8F9FA] text-[#9CA1A8]")}>{char}</kbd>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="flex h-[110px] flex-col items-center justify-center gap-1 text-[10.5px] text-[#9AA0A8]">
                <Search size={16} className="mb-1 text-[#C3C7CC]" />
                No commands match “{query}”
              </div>
            )}
          </div>

          <div className="flex h-[31px] items-center gap-3 border-t border-[#ECEEF1] bg-[#FAFBFC] px-3 text-[8px] text-[#A0A5AC]">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> run</span>
            <span className="flex items-center gap-1"><Kbd>esc</Kbd> dismiss</span>
            <span className="ml-auto flex items-center gap-1.5"><span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" /> Aether Command</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
