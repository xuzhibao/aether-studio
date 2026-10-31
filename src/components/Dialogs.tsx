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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" style={{ width, maxWidth: "calc(100vw - 64px)" }}>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Dialog.Close asChild>
      <button className="flex h-[24px] w-[24px] items-center justify-center rounded-[5px] text-[#8B9199] hover:bg-[#F0F2F4] hover:text-[#4D545C]" onClick={onClick}>
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
  const [board, setBoard] = useState("ESP32-S3 DevKitC-1");
  const [template, setTemplate] = useState("Environment monitor");

  useEffect(() => {
    if (dialog === "new-project") {
      setName("Greenhouse Climate Node");
      setBoard("ESP32-S3 DevKitC-1");
      setTemplate("Environment monitor");
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
          <button className="flex items-center gap-1 text-[9px] text-[#7D848C] hover:text-[#007AFF]" onClick={() => useStudio.getState().addToast({ title: "Board manager", detail: "Install additional board packages from the registry.", tone: "default" })}>
            Manage boards <ChevronRight size={10} />
          </button>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          {[
            ["ESP32-S3 DevKitC-1", "Dual-core LX7 · 240 MHz", "8 MB flash"],
            ["Arduino Nano ESP32", "u-blox NORA-W106", "Wi-Fi · BLE"],
            ["STM32 Nucleo-F411", "Cortex-M4 · 100 MHz", "512 KB flash"],
          ].map(([label, meta, spec]) => {
            const value = label.startsWith("STM32") ? "STM32 Nucleo-F411RE" : label;
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
            {[
              ["Environment monitor", "BME280 + OLED climate node", Thermometer],
              ["Air quality", "PM2.5 + VOC sensing", Wind],
              ["Plant waterer", "Soil moisture + pump", Droplets],
              ["Blank workspace", "Board and empty canvas", Square],
            ].map(([label, meta, Icon]) => {
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
        <span className="flex items-center gap-1.5 text-[8.5px] text-[#9AA0A8]"><CircuitBoard size={10} /> Local workspace · auto-saved</span>
        <div className="flex items-center gap-1.5">
          <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => setDialog(null)}>Cancel</button>
          <button
            className="btn btn-primary h-[27px] px-3 text-[10px]"
            disabled={!name.trim()}
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
  const { dialog, setDialog, deployDone, setTab } = useStudio();
  const [progress, setProgress] = useState(0);
  const [complete, setComplete] = useState(false);
  const doneRef = useRef(false);
  const open = dialog === "deploy";

  useEffect(() => {
    if (!open) return;
    setProgress(0);
    setComplete(false);
    doneRef.current = false;
    const timer = window.setInterval(() => {
      setProgress((value) => {
        const next = Math.min(100, value + 1.4 + Math.random() * 2.2);
        if (next >= 100 && !doneRef.current) {
          doneRef.current = true;
          setComplete(true);
          window.setTimeout(() => deployDone(), 200);
        }
        return next;
      });
    }, 85);
    return () => window.clearInterval(timer);
  }, [open, deployDone]);

  const steps = [
    { label: "Compile firmware", at: 0, detail: "MicroPython · ESP32-S3" },
    { label: "Erase flash region", at: 26, detail: "0x10000 – 0x220000" },
    { label: "Write firmware", at: 40, detail: "1.2 MB · USB Serial/JTAG" },
    { label: "Verify checksum", at: 84, detail: "SHA-256" },
    { label: "Reboot device", at: 96, detail: "COM3 · 115200" },
  ];
  const activeStep = steps.reduce((acc, step, index) => (progress >= step.at ? index : acc), 0);

  return (
    <Modal open={open} onOpenChange={(value) => !value && setDialog(null)} width={482}>
      <Dialog.Title className="sr-only">Deploy to device</Dialog.Title>
      <Dialog.Description className="sr-only">Flash the current firmware to the connected ESP32-S3 board.</Dialog.Description>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-[#EEF4FB] text-[#3F6FA5]"><ArrowUpToLine size={17} strokeWidth={1.8} /></div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-[#23272C]">Deploy to device</div>
          <div className="mt-0.5 text-[10px] text-[#90969E]">Flash the verified build over USB-C.</div>
        </div>
        <CloseButton onClick={() => setDialog(null)} />
      </div>

      <div className="px-5 pb-4">
        <div className="flex items-center gap-2.5 rounded-[7px] border border-[#E7EAEE] bg-[#FAFBFC] px-2.5 py-2">
          <span className="flex h-[28px] w-[22px] items-center justify-center"><BoardGlyph active /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10.5px] font-[550] text-[#343A41]">ESP32-S3 DevKitC-1 <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" /></div>
            <div className="mt-[1px] text-[8.5px] text-[#979DA6]">USB Serial/JTAG · COM3 · 115200 baud</div>
          </div>
          <span className="flex items-center gap-1 text-[8.5px] text-[#2B7F58]"><Usb size={10} /> Connected</span>
        </div>

        <div className="mt-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[9.5px] font-medium text-[#555C64]">{complete ? "Deployment complete" : steps[activeStep].label}</span>
            <span className="tabular text-[9px] font-medium text-[#5B636B]">{Math.round(progress)}%</span>
          </div>
          <div className="h-[5px] w-full overflow-hidden rounded-full bg-[#ECEEF2]">
            <div className="h-full rounded-full bg-[#007AFF] transition-[width] duration-150" style={{ width: progress + "%" }} />
          </div>
        </div>

        <div className="mt-3 space-y-0.5">
          {steps.map((step, index) => {
            const done = complete || progress > (steps[index + 1]?.at ?? 100);
            const active = !complete && index === activeStep;
            return (
              <div key={step.label} className="flex h-[26px] items-center gap-2.5 rounded-[4px] px-1">
                <span className={cn("flex h-[15px] w-[15px] items-center justify-center rounded-full", done ? "bg-[#EAF6EF] text-[#2B9661]" : active ? "bg-[#EAF3FF] text-[#007AFF]" : "border border-[#E3E6EA] bg-white text-[#C1C5CB]")}>
                  {done ? <Check size={8.5} strokeWidth={2.8} /> : active ? <LoaderCircle size={9} className="spin-slow" /> : <span className="h-[3px] w-[3px] rounded-full bg-current" />}
                </span>
                <span className={cn("text-[9.5px]", done ? "text-[#495057]" : active ? "font-medium text-[#2D333A]" : "text-[#A2A7AE]")}>{step.label}</span>
                <span className="ml-auto font-mono text-[8px] text-[#A6ABB2]">{step.detail}</span>
              </div>
            );
          })}
        </div>

        {complete && (
          <div className="mt-3 flex items-center gap-2 rounded-[6px] border border-[#D8EDE1] bg-[#F0F8F4] px-2.5 py-2">
            <CheckCircle2 size={15} className="text-[#2B9661]" />
            <div className="flex-1">
              <div className="text-[9.5px] font-semibold text-[#286A4B]">Firmware deployed successfully</div>
              <div className="mt-[1px] text-[8px] text-[#65A183]">1.2 MB written · checksum verified · board rebooted in 8.4 s</div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => setDialog(null)}>Cancel</button>
        {complete ? (
          <>
            <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => { setTab("serial"); setDialog(null); }}>Open Serial Monitor</button>
            <button className="btn btn-primary h-[27px] px-3 text-[10px]" onClick={() => setDialog(null)}>Done</button>
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-[8.5px] text-[#9AA0A8]"><LoaderCircle size={10} className="spin-slow" /> Do not disconnect the board</span>
        )}
      </div>
    </Modal>
  );
}

// devices/tests/overview appended below
