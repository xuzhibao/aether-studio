import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  Cloud,
  Plus,
  Radio,
  RefreshCw,
  Usb,
  Wifi,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { CloseButton, Modal } from "./Dialogs";

export function DevicesDialog() {
  const { dialog, setDialog, addToast, deviceConnected } = useStudio();
  const [selected, setSelected] = useState("board");

  useEffect(() => {
    if (dialog === "devices") setSelected("board");
  }, [dialog]);

  return (
    <Modal open={dialog === "devices"} onOpenChange={(open) => !open && setDialog(null)} width={566}>
      <Dialog.Title className="sr-only">Devices</Dialog.Title>
      <Dialog.Description className="sr-only">Manage the virtual board and cloud connections.</Dialog.Description>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-[#EEF4FB] text-[#3F6FA5]"><Radio size={17} strokeWidth={1.7} /></div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-[#23272C]">Devices</div>
          <div className="mt-0.5 text-[10px] text-[#90969E]">Virtual hardware and connected services for this project.</div>
        </div>
        <button className="flex h-[24px] items-center gap-1 rounded-[5px] px-1.5 text-[9px] text-[#7D848C] hover:bg-[#F1F3F5]" onClick={() => addToast({ title: "Devices refreshed", detail: "1 virtual board · 1 cloud link online", tone: "success" })}>
          <RefreshCw size={10.5} /> Refresh
        </button>
        <CloseButton onClick={() => setDialog(null)} />
      </div>

      <div className="px-5 pb-4">
        <div className="space-y-1.5">
          {[
            { id: "board", icon: Usb, title: "ESP32-S3 DevKitC-1", meta: "USB Serial/JTAG · COM3", status: deviceConnected ? "Connected" : "Offline", sub: "Virtual · This workspace" },
            { id: "cloud", icon: Cloud, title: "Aether Cloud", meta: "MQTT · mqtt://aether.local", status: "Online", sub: "QoS 1 · 42 ms · env-monitor" },
          ].map((device) => {
            const Icon = device.icon;
            return (
              <button
                key={device.id}
                onClick={() => setSelected(device.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-[7px] border px-2.5 py-2.5 text-left transition-all",
                  selected === device.id ? "border-[#B8D7F8] bg-[#F5FAFF]" : "border-[#E6E9ED] bg-white hover:border-[#D6DBE1]",
                )}
              >
                <span className={cn("flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[6px]", selected === device.id ? "bg-white text-[#2F7DCE] shadow-sm" : "bg-[#F3F5F7] text-[#68717B]")}>
                  <Icon size={14} strokeWidth={1.7} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[10.5px] font-[550] text-[#343A41]">{device.title}</span>
                  <span className="mt-[2px] block text-[8.5px] text-[#989EA6]">{device.meta} · {device.sub}</span>
                </span>
                <span className="flex items-center gap-1 text-[8.5px] font-medium text-[#2B7F58]">
                  <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" /> {device.status}
                </span>
                <span className={cn("ml-1 flex h-[15px] w-[15px] items-center justify-center rounded-full border", selected === device.id ? "border-[#007AFF] bg-[#007AFF]" : "border-[#D6DAE0] bg-white")}>
                  {selected === device.id && <Check size={8.5} strokeWidth={3} className="text-white" />}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 rounded-[7px] border border-[#E8EAEE]">
          <div className="flex h-[27px] items-center justify-between border-b border-[#EEF0F3] px-3">
            <span className="text-[9px] font-semibold text-[#5A6169]">{selected === "board" ? "Board details" : "Cloud link details"}</span>
            <span className="text-[8px] text-[#A0A5AC]">{selected === "board" ? "Virtual hardware" : "MQTT 3.1.1"}</span>
          </div>
          <div className="grid grid-cols-3 gap-px bg-[#EEF0F3]">
            {(selected === "board"
              ? [
                  ["Port", "COM3"], ["Baud rate", "115200"], ["Firmware", "MicroPython 1.23"],
                  ["Flash", "8 MB"], ["PSRAM", "2 MB"], ["Uptime", "00:01:42"],
                ]
              : [
                  ["Broker", "aether.local"], ["Port", "1883"], ["QoS", "1"],
                  ["Client ID", "env-monitor-01"], ["Latency", "42 ms"], ["Keepalive", "60 s"],
                ]
            ).map(([label, value]) => (
              <div key={label} className="bg-white px-3 py-2">
                <div className="text-[8px] uppercase tracking-[0.04em] text-[#A2A7AE]">{label}</div>
                <div className="mt-[2px] font-mono text-[9px] text-[#454C54]">{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 rounded-[7px] border border-[#E8EAEE] bg-[#FAFBFC] px-3 py-2.5">
          <Wifi size={13} className="text-[#6F7A86]" />
          <div className="flex-1">
            <div className="text-[9.5px] font-medium text-[#444A51]">AetherLab</div>
            <div className="mt-[1px] text-[8px] text-[#9BA0A8]">192.168.1.42 · Wi-Fi 5 · RSSI −48 dBm</div>
          </div>
          <div className="flex items-end gap-[2px]">
            {[3, 5, 7, 9].map((height, i) => (
              <span key={i} className={cn("w-[2.5px] rounded-sm", i < 3 ? "bg-[#5B9EDD]" : "bg-[#DDE2E8]")} style={{ height }} />
            ))}
          </div>
          <span className="ml-2 rounded-[4px] bg-[#EBF6EF] px-1.5 py-[2px] text-[8px] font-medium text-[#2B7F58]">Signal good</span>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <button className="flex items-center gap-1.5 text-[9px] text-[#6E767F] hover:text-[#007AFF]" onClick={() => addToast({ title: "Pair a device", detail: "Connect a physical board over USB to continue.", tone: "default" })}>
          <Plus size={10.5} /> Pair physical device
        </button>
        <button className="btn btn-primary h-[27px] px-3 text-[10px]" onClick={() => setDialog(null)}>Done</button>
      </div>
    </Modal>
  );
}
