import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  Check,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { Spinner } from "./ui";
import { CloseButton, Modal } from "./Dialogs";

export function TestsDialog() {
  const { dialog, setDialog, addToast } = useStudio();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (dialog === "tests") setRunning(false);
  }, [dialog]);

  const tests = [
    ["I2C bus scan", "2 devices found · 0x76, 0x3C", "12 ms"],
    ["BME280 identity", "Chip ID 0x60 · calibration valid", "8 ms"],
    ["BME280 read", "24.6 °C · 48.2 % · 1013 hPa", "21 ms"],
    ["SSD1306 initialize", "128 × 64 framebuffer ready", "34 ms"],
    ["OLED frame update", "Partial refresh · 60 FPS", "118 ms"],
    ["30 second soak", "15 / 15 samples · 0 drops", "30.02 s"],
    ["MQTT publish", "QoS 1 acknowledgement", "42 ms"],
  ];

  return (
    <Modal open={dialog === "tests"} onOpenChange={(open) => !open && setDialog(null)} width={566}>
      <Dialog.Title className="sr-only">Test reports</Dialog.Title>
      <Dialog.Description className="sr-only">Latest hardware and firmware verification results.</Dialog.Description>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[8px] bg-[#EDF6F1] text-[#3E7D5D]"><FlaskConical size={17} strokeWidth={1.7} /></div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[#23272C]">Test Reports</span>
            <span className="flex h-[16px] items-center gap-1 rounded-[4px] bg-[#EBF6EF] px-1.5 text-[8px] font-medium text-[#2B7F58]"><Check size={8} /> 7 / 7 passed</span>
          </div>
          <div className="mt-0.5 text-[10px] text-[#90969E]">Last run on the virtual board · 12:04:35</div>
        </div>
        <CloseButton onClick={() => setDialog(null)} />
      </div>

      <div className="px-5 pb-4">
        <div className="overflow-hidden rounded-[7px] border border-[#E8EAEE]">
          {tests.map(([name, detail, duration], i) => (
            <div key={name} className={cn("flex items-center gap-2.5 px-3 py-2", i !== tests.length - 1 && "border-b border-[#F0F2F4]")}>
              <span className={cn("flex h-[15px] w-[15px] flex-none items-center justify-center rounded-full", running ? "bg-[#F2F4F6] text-[#B7BCC3]" : "bg-[#EAF6EF] text-[#2B9661]")}>
                {running ? <LoaderCircle size={9} className="spin-slow" /> : <Check size={8.5} strokeWidth={2.8} />}
              </span>
              <span className="w-[120px] flex-none text-[9.5px] font-medium text-[#3F454C]">{name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[8px] text-[#979DA5]">{detail}</span>
              <span className="tabular text-[8px] text-[#A7ABB2]">{running ? "—" : duration}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between rounded-[6px] bg-[#FAFBFC] px-3 py-2 text-[8.5px] text-[#949AA2]">
          <span className="flex items-center gap-1.5"><Activity size={10} /> Coverage: 94% · i2c, display, network</span>
          <span className="tabular">Runtime 30.2 s</span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-[#ECEEF1] bg-[#FAFBFC] px-4 py-2.5">
        <button className="btn h-[27px] px-2.5 text-[10px]" onClick={() => addToast({ title: "Report exported", detail: "test-report-env-monitor.pdf", tone: "success" })}>Export Report</button>
        <button
          className="btn btn-primary h-[27px] px-3 text-[10px]"
          disabled={running}
          onClick={() => {
            setRunning(true);
            window.setTimeout(() => {
              setRunning(false);
              addToast({ title: "Tests passed", detail: "7 / 7 checks completed · 30.2 s", tone: "success" });
            }, 1600);
          }}
        >
          {running ? <Spinner size={10} /> : <RefreshCw size={10.5} />}
          {running ? "Running…" : "Run All Tests"}
        </button>
      </div>
    </Modal>
  );
}
