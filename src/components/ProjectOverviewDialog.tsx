import * as Dialog from "@radix-ui/react-dialog";
import { CircuitBoard, FileCode2 } from "lucide-react";
import { useStudio } from "../store/studio";
import { formatElapsed } from "../lib/utils";
import { CloseButton, Modal } from "./Dialogs";

export function ProjectOverviewDialog() {
  const { dialog, setDialog, setTab, components, wires, activeProjectId, projects, elapsed } = useStudio();
  const project = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const activity = [
    ["Aether verified I²C bus", "30 samples · 0 warnings", "12:04"],
    ["Firmware compiled", "main.py · 1.42 s", "12:03"],
    ["OLED display connected", "SSD1306 · 0x3C", "12:02"],
    ["BME280 added to bench", "U2 · I²C 0x76", "12:01"],
  ];

  return (
    <Modal open={dialog === "overview"} onOpenChange={(open) => !open && setDialog(null)} width={664}>
      <Dialog.Title className="sr-only">Project overview</Dialog.Title>
      <Dialog.Description className="sr-only">Summary of the active Aether Studio project.</Dialog.Description>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <span className="flex h-[36px] w-[36px] flex-none items-center justify-center rounded-[9px] bg-[#1E2329] text-white shadow-sm"><CircuitBoard size={18} strokeWidth={1.6} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold tracking-[-0.015em] text-[#22262B]">{project.name}</span>
            <span className="rounded-[4px] border border-[#E3E6EA] bg-white px-1.5 py-[1px] text-[8px] text-[#8E949C]">Rev A</span>
          </div>
          <div className="mt-1 max-w-[470px] text-[10px] leading-[1.55] text-[#8D939B]">{project.description}</div>
          <div className="mt-2 flex items-center gap-1.5">
            {[project.board, "MicroPython 1.23", "I²C 400 kHz"].map((chip) => (
              <span key={chip} className="rounded-[4px] bg-[#F2F4F7] px-1.5 py-[2px] text-[8.5px] text-[#737B84]">{chip}</span>
            ))}
          </div>
        </div>
        <CloseButton onClick={() => setDialog(null)} />
      </div>

      <div className="grid grid-cols-[1.05fr_1fr] gap-0 border-t border-[#ECEEF1]">
        <div className="border-r border-[#ECEEF1] px-5 py-3.5">
          <div className="flex items-center justify-between">
            <span className="label-caps text-[8.5px]">Hardware · {components.length}</span>
            <button className="text-[8.5px] text-[#7F868E] hover:text-[#007AFF]" onClick={() => { setDialog(null); setTab("circuit"); }}>Open bench</button>
          </div>
          <div className="mt-1.5 space-y-0.5">
            {components.map((comp) => (
              <div key={comp.id} className="flex h-[27px] items-center gap-2 rounded-[4px] px-1 hover:bg-[#F7F8FA]">
                <span className="h-[5px] w-[5px] rounded-full" style={{ background: comp.kind === "board" ? "#3E4A58" : comp.kind === "bme280" ? "#4E7CA6" : comp.kind === "oled" ? "#3D7E8A" : comp.kind === "led" ? "#D06456" : "#A58A50" }} />
                <span className="flex-1 truncate text-[9.5px] text-[#474D55]">{comp.name}</span>
                <span className="font-mono text-[8px] text-[#A6ABB2]">{comp.reference}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-[#EEF0F3] pt-2.5">
            <div className="label-caps mb-1.5 text-[8.5px]">Firmware</div>
            <div className="flex flex-wrap gap-1.5">
              {["main.py", "sensors.py", "config.json"].map((file) => (
                <button key={file} className="flex h-[23px] items-center gap-1 rounded-[5px] border border-[#E6E9ED] bg-[#FBFBFC] px-1.5 font-mono text-[8.5px] text-[#555C64] hover:border-[#CCD9E6] hover:bg-white" onClick={() => { setDialog(null); useStudio.getState().openFile(file); }}>
                  <FileCode2 size={9.5} className="text-[#527FA4]" /> {file}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-3.5">
          <div className="label-caps text-[8.5px]">Recent activity</div>
          <div className="mt-2 space-y-2.5">
            {activity.map(([title, detail, time]) => (
              <div key={title} className="flex gap-2">
                <span className="mt-[4px] h-[5px] w-[5px] flex-none rounded-full bg-[#7FB3E6] shadow-[0_0_0_2.5px_rgba(127,179,230,0.14)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-[9.5px] leading-[1.35] text-[#444A52]">{title}</div>
                  <div className="mt-[1px] text-[8px] text-[#A0A6AE]">{detail}</div>
                </div>
                <span className="tabular text-[8px] text-[#B2B6BC]">{time}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#EEF0F3] pt-2.5">
            {[
              ["Sampling", "2.0 s"],
              ["Nets", String(wires.length)],
              ["Uptime", formatElapsed(elapsed)],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="text-[7.5px] uppercase tracking-[0.05em] text-[#A6ABB2]">{label}</div>
                <div className="mt-[1px] text-[10px] font-medium tabular text-[#454C54]">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[8.5px] text-[#969CA4]"><span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" /> Local workspace · saved</span>
        <div className="flex gap-1.5">
          <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => setDialog("new-project")}>New Project</button>
          <button className="btn btn-primary h-[27px] px-3 text-[10px]" onClick={() => { setDialog(null); setTab("circuit"); }}>Open Workspace</button>
        </div>
      </div>
    </Modal>
  );
}
