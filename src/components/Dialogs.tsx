import { usePlugins } from "../plugins/usePlugins";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  ArrowUpToLine,
  Check,
  CheckCircle2,
  ChevronRight,
  CircuitBoard,
  Cloud,
  Cpu,
  Droplets,
  FileCode2,
  FlaskConical,
  FolderPlus,
  Gauge,
  LoaderCircle,
  Monitor,
  Plus,
  Radio,
  RefreshCw,
  Square,
  Thermometer,
  Usb,
  Wind,
  Wifi,
  X,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";

export function Modal({
  open,
  onOpenChange,
  children,
  width = 560,
  onOpenAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  width?: number;
  onOpenAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content onOpenAutoFocus={onOpenAutoFocus} className="dialog" style={{ width, maxWidth: "calc(100vw - 64px)" }}>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Dialog.Close asChild>
      <button className="flex h-[24px] w-[24px] items-center justify-center rounded-[5px] text-[#8B9199] hover:bg-[#F0F2F4] hover:text-[#4D545C]" aria-label="Close dialog" onClick={onClick}>
        <X size={13} />
      </button>
    </Dialog.Close>
  );
}

function BoardGlyph({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="32" viewBox="0 0 24 32" fill="none">
      <rect x="4" y="1" width="16" height="30" rx="2.5" fill={active ? "#3C4653" : "#A7AFB8"} />
      <rect x="7.5" y="5" width="9" height="8" rx="1" fill={active ? "#C6D1DD" : "#DDE3E9"} />
      <rect x="9.5" y="26" width="5" height="2.8" rx="1" fill={active ? "#9BA8B5" : "#CDD4DB"} />
      {[6, 10, 14, 18, 22].map((y) => (
        <g key={y}>
          <rect x="1.4" y={y} width="3" height="2" rx="0.4" fill={active ? "#D8B96F" : "#C5CBD2"} />
          <rect x="19.6" y={y} width="3" height="2" rx="0.4" fill={active ? "#D8B96F" : "#C5CBD2"} />
        </g>
      ))}
    </svg>
  );
}

export function NewProjectDialog() {
  const { dialog, setDialog, createProject } = useStudio();
  const [name, setName] = useState("Greenhouse Climate Node");
  const registry = usePlugins();
  const boards = registry.all("boards");
  const templates = registry.all("templates");
  const [board, setBoard] = useState("");
  const [template, setTemplate] = useState("");

  useEffect(() => {
    if (dialog === "new-project") {
      setName("Greenhouse Climate Node");
      setBoard(boards[0]?.id ?? "");
      setTemplate(templates[0]?.id ?? "");
    }
  }, [dialog]);

  return (
    <Modal open={dialog === "new-project"} onOpenChange={(open) => !open && setDialog(null)} width={566}>
      <Dialog.Title className="sr-only">Create project</Dialog.Title>
      <Dialog.Description className="sr-only">Create a new hardware workspace in Aether Studio.</Dialog.Description>
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-[#EEF4FB] text-[#3F6FA5] shadow-[inset_0_0_0_0.5px_rgba(20,24,33,0.06)]">
          <FolderPlus size={17} strokeWidth={1.7} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-[-0.012em] text-[#23272C]">Create a project</div>
          <div className="mt-0.5 text-[10px] text-[#90969E]">A new workspace with a virtual board, circuit and firmware.</div>
        </div>
        <CloseButton onClick={() => setDialog(null)} />
      </div>

      <div className="border-t border-[#ECEEF1] px-5 py-4">
        <label className="label-caps mb-1.5 block text-[8.5px]">Project name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input h-[32px] w-full text-[11.5px]"
          placeholder="Untitled workspace"
        />

        <div className="mt-4 flex items-center justify-between">
          <span className="label-caps text-[8.5px]">Target board</span>
          <button className="flex items-center gap-1 text-[9px] text-[#7D848C] hover:text-[#007AFF]" onClick={() => setDialog("plugins")}>
            Manage boards <ChevronRight size={10} />
          </button>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          {boards.map((definition) => {
            const label = definition.name;
            const meta = definition.description;
            const spec = "来自已启用插件";
            const value = definition.id;
            const selected = board === value;
            return (
              <button
                key={label}
                onClick={() => setBoard(value)}
                className={cn(
                  "relative flex flex-col items-start rounded-[7px] border p-2.5 text-left transition-all",
                  selected ? "border-[#9CC7F5] bg-[#F5FAFF] shadow-[0_0_0_2px_rgba(0,122,255,0.06)]" : "border-[#E5E8EC] bg-white hover:border-[#D4D9DF]",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <BoardGlyph active={selected} />
                  <span className={cn("text-[9.5px] font-[560]", selected ? "text-[#185C9E]" : "text-[#454B53]")}>{label}</span>
                </div>
                <span className="mt-1.5 text-[8px] leading-[1.45] text-[#9298A0]">{meta}</span>
                <span className="text-[7.5px] text-[#B0B4BB]">{spec}</span>
                {selected && (
                  <span className="absolute right-2 top-2 flex h-[13px] w-[13px] items-center justify-center rounded-full bg-[#007AFF]">
                    <Check size={8} strokeWidth={3} className="text-white" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          <span className="label-caps mb-1.5 block text-[8.5px]">Start from</span>
          <div className="grid grid-cols-2 gap-1.5">
            {templates.filter((t) => t.board === board).map((definition) => {
              const label = definition.id;
              const meta = definition.description;
              const Icon = CircuitBoard;
              const selected = template === label;
              return (
                <button
                  key={label as string}
                  onClick={() => setTemplate(label as string)}
                  className={cn(
                    "flex items-center gap-2 rounded-[6px] border px-2.5 py-2 text-left transition-colors",
                    selected ? "border-[#B8D7F8] bg-[#F5FAFF]" : "border-[#E7EAEE] bg-white hover:border-[#D5DAE0]",
                  )}
                >
                  <span className={cn("flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[5px]", selected ? "bg-white text-[#2F7DCE]" : "bg-[#F4F6F8] text-[#8A929A]")}>
                    <Icon size={11.5} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[9.5px] font-[540] text-[#3E444B]">{label as string}</span>
                    <span className="mt-[1px] block truncate text-[8px] text-[#9AA0A8]">{meta as string}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[8.5px] text-[#9AA0A8]"><CircuitBoard size={10} /> Local workspace · 创建后保存</span>
        <div className="flex items-center gap-1.5">
          <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => setDialog(null)}>Cancel</button>
          <button
            className="btn btn-primary h-[27px] px-3 text-[10px]"
            disabled={!name.trim() || !boards.some((b) => b.id === board) || !templates.some((t) => t.id === template)}
            onClick={() => createProject({ name: name.trim(), board, template })}
          >
            Create Project
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DeployDialog() {
  const { dialog, setDialog } = useStudio();
  return <Modal open={dialog === "deploy"} onOpenChange={(open) => !open && setDialog(null)} width={482}>
    <div className="p-5"><div className="flex justify-between"><Dialog.Title className="text-[14px] font-semibold">Deploy · 尚未实现</Dialog.Title><CloseButton onClick={() => setDialog(null)} /></div><Dialog.Description className="mt-4 text-[12px] leading-6 text-[#7D848C]">串口和 WebSocket 插件仅提供数据通信，当前没有已接入的固件烧录插件。Demo Simulation 仅生成演示数据，不会编译或写入设备。</Dialog.Description></div>
  </Modal>;
}
