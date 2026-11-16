import { usePlugins } from "../plugins/usePlugins";
import { useState } from "react";
import {
  Puzzle,
  Activity,
  Braces,
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  Cloud,
  Component,
  Cpu,
  FileCode2,
  FileJson,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  Gauge,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  RefreshCw,
  Workflow,
  SlidersHorizontal,
  Usb,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { IconButton, SectionLabel, Tip } from "./ui";
import { ResizeDivider } from "./ResizeDivider";

const navigation = [
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "hardware", label: "Hardware", icon: Cpu },
  { id: "circuit", label: "Circuit", icon: Workflow },
  { id: "source", label: "Source Code", icon: FileCode2 },
  { id: "components", label: "Components", icon: Component, badge: "5" },
  { id: "simulation", label: "Simulation", icon: Activity },
  { id: "devices", label: "Devices", icon: Radio },
  { id: "tests", label: "Test Reports", icon: FlaskConical },
];

const fileMeta: Record<string, { icon: typeof FileCode2; color: string }> = {
  "main.py": { icon: FileCode2, color: "#3F7FCF" },
  "sensors.py": { icon: FileCode2, color: "#3F7FCF" },
  "config.json": { icon: FileJson, color: "#B98A2C" },
  "circuit.json": { icon: Braces, color: "#8B6FC9" },
  "esp32_s3.board": { icon: SlidersHorizontal, color: "#6C7B8F" },
  "README.md": { icon: FileText, color: "#7C838C" },
  "tests/check_i2c.py": { icon: FileCode2, color: "#3F9A75" },
};

function FileRow({ path, depth = 0 }: { path: string; depth?: number }) {
  const activeTab = useStudio((s) => s.activeTab);
  const openTabs = useStudio((s) => s.openTabs);
  const openFile = useStudio((s) => s.openFile);
  const meta = fileMeta[path] ?? { icon: FileText, color: "#7C838C" };
  const Icon = meta.icon;
  const label = path.split("/").pop() ?? path;
  const active = activeTab === path || (activeTab === "serial" && false);
  return (
    <button
      onClick={() => openFile(path)}
      className={cn("tree-row w-full", active && "active")}
      style={{ paddingLeft: 10 + depth * 16 }}
    >
      <Icon size={12} strokeWidth={1.75} style={{ color: active ? "#0B5FBE" : meta.color }} />
      <span className="truncate">{label}</span>
      {active && <span className="ml-auto h-[4px] w-[4px] rounded-full bg-[#007AFF]" />}
      {!active && openTabs.includes(path) && <span className="ml-auto h-[3px] w-[3px] rounded-full bg-[#B7CBE3]" />}
    </button>
  );
}

function FolderRow({
  label,
  open,
  onToggle,
  depth = 0,
  count,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  depth?: number;
  count?: number;
}) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <button
      onClick={onToggle}
      className="tree-row w-full text-[#5D626A]"
      style={{ paddingLeft: 6 + depth * 15 }}
    >
      {open ? <ChevronDown size={10} className="text-[#A0A5AC]" /> : <ChevronRight size={10} className="text-[#A0A5AC]" />}
      <Icon size={12} strokeWidth={1.65} className="text-[#8C939B]" />
      <span className="truncate font-[450]">{label}</span>
      {count !== undefined && <span className="ml-auto text-[9px] tabular text-[#B1B5BC]">{count}</span>}
    </button>
  );
}

export function Sidebar() {
  const {
    sidebarCollapsed,
    sidebarWidth,
    setSidebarCollapsed,
    setSidebarWidth,
    activeNav,
    setActiveNav,
    activeProjectId,
    projects,
    components,
    addToast,
    setDialog,
  } = useStudio();
  const registry = usePlugins();
  const panels = registry.all("panels");
  const files = useStudio((s) => s.files);
  const project = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const [rootOpen, setRootOpen] = useState(true);
  const [firmwareOpen, setFirmwareOpen] = useState(true);
  const [hardwareOpen, setHardwareOpen] = useState(true);
  const [testsOpen, setTestsOpen] = useState(false);

  if (sidebarCollapsed) {
    return (
      <div className="flex flex-none">
        <aside className="glass flex h-full w-[48px] flex-col items-center border-r border-[#E8EAED] pt-2.5">
          <Tip label="Expand sidebar" side="right">
            <button className="mb-2 flex h-7 w-7 items-center justify-center rounded-[6px] text-[#7C828B] hover:bg-[#ECEEF1]" onClick={() => setSidebarCollapsed(false)}>
              <PanelLeftOpen size={15} strokeWidth={1.7} />
            </button>
          </Tip>
          <div className="mb-2 h-px w-5 bg-[#E8EAED]" />
          <div className="flex flex-col gap-0.5">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Tip key={item.id} label={item.label} side="right">
                  <button
                    onClick={() => setActiveNav(item.id)}
                    className={cn(
                      "relative flex h-[29px] w-[30px] items-center justify-center rounded-[6px] text-[#858B93] transition-colors hover:bg-[#ECEEF1] hover:text-[#1D1D1F]",
                      activeNav === item.id && "bg-[#E8EAEE] text-[#1D1D1F]",
                    )}
                  >
                    <Icon size={15} strokeWidth={1.7} />
                    {item.id === "simulation" && <span className="absolute right-[5px] top-[5px] h-[4px] w-[4px] rounded-full bg-[#2B9661]" />}
                  </button>
                </Tip>
              );
            })}
          </div>
          <div className="mt-auto flex flex-col items-center gap-2 pb-3">
            <button
              onClick={() => setDialog("devices")}
              className="relative flex h-7 w-7 items-center justify-center rounded-[6px] text-[#6E747C] hover:bg-[#ECEEF1]"
              aria-label="Devices"
            >
              <Usb size={14} />
              <span className="absolute right-[5px] top-[5px] h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
            </button>
          </div>
        </aside>
        <ResizeDivider axis="x" value={sidebarWidth} min={208} max={304} onChange={setSidebarWidth} />
      </div>
    );
  }

  return (
    <div className="flex flex-none">
      <aside className="glass flex h-full flex-col overflow-hidden border-r border-[#E8EAED]" style={{ width: sidebarWidth }}>
        <div className="flex h-[42px] flex-none items-center justify-between pl-3.5 pr-2">
          <SectionLabel>Explorer</SectionLabel>
          <div className="flex items-center">
            <IconButton label="New file" className="h-[24px] w-[24px]" onClick={() => setDialog("new-file")}>
              <Plus size={13} />
            </IconButton>
            <IconButton label="Collapse sidebar" className="h-[24px] w-[24px]" onClick={() => setSidebarCollapsed(true)}>
              <PanelLeftClose size={13.5} />
            </IconButton>
          </div>
        </div>

        <nav className="flex-none px-2">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveNav(item.id)}
                className={cn("sidebar-item w-full", active && "active")}
              >
                <Icon size={13.5} strokeWidth={1.7} className="sidebar-icon" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.id === "simulation" && (
                  <span className="flex items-center gap-1 text-[9px] font-medium text-[#2B9661]">
                    <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
                    Demo
                  </span>
                )}
                {item.id === "components" ? (
                  <span className="text-[9.5px] tabular text-[#A3A8AF]">{components.length}</span>
                ) : (
                  item.badge && <span className="text-[9.5px] tabular text-[#A3A8AF]">{item.badge}</span>
                )}
              </button>
            );
          })}
          {panels.map((panel) => <button key={panel.id} className="sidebar-item w-full text-left" onClick={() => useStudio.getState().setTab("panel:" + panel.id)}><Puzzle size={13} />{panel.name}</button>)}
        </nav>

        <div className="mx-3 my-2.5 h-px flex-none bg-[#E9EBEE]" />

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-none items-center justify-between px-3.5 pb-1.5">
            <SectionLabel>Project files</SectionLabel>
            <span className="text-[9px] text-[#AEB2B9]">{Object.keys(files).filter((f) => f !== "circuit.json").length + 1} files</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
            <button className="tree-row w-full gap-1.5 font-[520] text-[#33373D]" onClick={() => setRootOpen(!rootOpen)}>
              {rootOpen ? <ChevronDown size={10} className="text-[#A0A5AC]" /> : <ChevronRight size={10} className="text-[#A0A5AC]" />}
              <span className="flex h-[15px] w-[15px] items-center justify-center rounded-[4px] bg-[#E9EEF8] text-[#3F6FB8]">
                <CircuitBoard size={9.5} strokeWidth={2} />
              </span>
              <span className="min-w-0 truncate">{project.name}</span>
            </button>

            {rootOpen && (
              <div className="mt-0.5">
                <ProjectTree files={Object.keys(files)} />
              </div>
            )}
          </div>

          <div className="mx-2 mb-2 flex-none rounded-[7px] border border-[#E7EAEE] bg-white/55 px-2.5 py-2">
            <div className="flex items-center justify-between">
              <SectionLabel>Project notes</SectionLabel>
              <button className="flex h-[17px] w-[17px] items-center justify-center rounded-[3px] text-[#A0A5AC] hover:bg-[#EEF0F3] hover:text-[#5D646C]" onClick={() => addToast({ title: "Project notes", detail: "Notes are stored locally with this workspace.", tone: "default" })}>
                <FileCode2 size={9.5} />
              </button>
            </div>
            <p className="mt-1 text-[9px] leading-[1.55] text-[#7E858D]">Demo Simulation 生成数据；不执行固件、不连接真实硬件。</p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="flex items-center gap-1 text-[8px] text-[#2B7F58]"><span className="h-[3.5px] w-[3.5px] rounded-full bg-[#2B9661]" /> Demo only</span>
              <span className="text-[8px] text-[#C0C4CA]">·</span>
              <span className="text-[8px] text-[#A0A5AC]">Rev A</span>
            </div>
          </div>
        </div>

        <div className="flex-none border-t border-[#E9EBEE] px-2.5 pb-2.5 pt-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <SectionLabel>Demo Simulation</SectionLabel>
            <button className="flex h-[18px] w-[18px] items-center justify-center rounded text-[#9BA0A8] hover:bg-[#ECEEF1] hover:text-[#565B63]" onClick={() => setDialog("devices")}>
              <RefreshCw size={10.5} />
            </button>
          </div>
          <button
            onClick={() => setDialog("devices")}
            className="flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left transition-colors hover:bg-[#EEF1F4]"
          >
            <span className="flex h-[24px] w-[24px] flex-none items-center justify-center rounded-[6px] bg-white text-[#525860] shadow-[0_0_0_0.5px_rgba(20,24,33,0.08),0_1px_2px_rgba(20,24,33,0.04)]">
              <Usb size={12.5} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[10.5px] font-[520] text-[#3A3E44]">{project.board}</span>
                <span className="h-[4px] w-[4px] flex-none rounded-full bg-[#2B9661]" />
              </span>
              <span className="mt-[1px] block text-[9px] text-[#9CA1A8]">Demo output · 无真实设备</span>
            </span>
          </button>
          <button
            onClick={() => setDialog("devices")}
            className="flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left transition-colors hover:bg-[#EEF1F4]"
          >
            <span className="flex h-[24px] w-[24px] flex-none items-center justify-center rounded-[6px] bg-white text-[#525860] shadow-[0_0_0_0.5px_rgba(20,24,33,0.08),0_1px_2px_rgba(20,24,33,0.04)]">
              <Cloud size={12.5} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[10.5px] font-[520] text-[#3A3E44]">Cloud transport</span>
                <span className="h-[4px] w-[4px] flex-none rounded-full bg-[#2B9661]" />
              </span>
              <span className="mt-[1px] block text-[9px] text-[#9CA1A8]">尚未实现</span>
            </span>
          </button>
        </div>
      </aside>
      <ResizeDivider axis="x" value={sidebarWidth} min={208} max={304} onChange={setSidebarWidth} />
    </div>
  );
}

function ProjectTree({ files, prefix = "", depth = 1 }: { files: string[]; prefix?: string; depth?: number }) {
  const [closed, setClosed] = useState<string[]>([]);
  const children = [...new Set(files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split("/")[0]))].sort();
  return <>{children.map((name) => {
    const key = prefix + name;
    const directory = files.some((file) => file.startsWith(key + "/"));
    return directory ? <div key={key}><FolderRow label={name} depth={depth} open={!closed.includes(key)} onToggle={() => setClosed(closed.includes(key) ? closed.filter((item) => item !== key) : [...closed, key])} />{!closed.includes(key) && <ProjectTree files={files} prefix={key + "/"} depth={depth + 1} />}</div> : <FileRow key={key} path={key} depth={depth} />;
  })}</>;
}
