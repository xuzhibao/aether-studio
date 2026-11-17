import { motion } from "motion/react";
import { Cable, FileCode2, Info, Link2, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { HwComponent } from "../../types";
import { useStudio } from "../../store/studio";
import { cn } from "../../lib/utils";
import { IconButton, Tip } from "../ui";

const signalColor: Record<string, string> = {
  power: "#E15B4F",
  gnd: "#5A6069",
  i2c: "#2F7FD8",
  gpio: "#3B9A68",
  analog: "#8A6DCC",
  pwm: "#D9962F",
};

function TypeGlyph({ kind }: { kind: string }) {
  return (
    <div className="flex h-[29px] w-[29px] flex-none items-center justify-center rounded-[7px] bg-[#F1F4F8] text-[#4B6079] shadow-[inset_0_0_0_0.5px_rgba(20,24,33,0.06)]">
      {kind === "board" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="2" width="10" height="12" rx="2" fill="#4C5968" />
          <rect x="5.3" y="4.3" width="5.4" height="4.4" rx="0.7" fill="#B7C2CF" />
          <path d="M1.5 5H3M1.5 8H3M1.5 11H3M13 5h1.5M13 8h1.5M13 11h1.5" stroke="#8794A3" strokeWidth="0.9" />
        </svg>
      ) : kind === "oled" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1.5" y="3" width="13" height="9" rx="1.4" fill="#2E3A48" />
          <rect x="3" y="4.5" width="10" height="6" rx="0.6" fill="#3E7C8A" />
          <path d="M3.6 12.5v1.5M5.6 12.5v1.5M10.4 12.5v1.5M12.4 12.5v1.5" stroke="#8794A3" strokeWidth="0.9" />
        </svg>
      ) : kind === "bme280" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="12" height="12" rx="2" fill="#354C67" />
          <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2" fill="#B9C4CE" />
          <circle cx="8" cy="8" r="1.6" fill="#6D7B88" />
        </svg>
      ) : kind === "led" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="7" r="4.2" fill="#E4685B" />
          <circle cx="6.6" cy="5.7" r="1.3" fill="#FFD4CC" />
          <path d="M6 11v3M10 11v3" stroke="#8C939B" strokeWidth="1" />
        </svg>
      ) : kind === "resistor" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M1 8h3M12 8h3" stroke="#8C939B" strokeWidth="1.1" />
          <rect x="4" y="5" width="8" height="6" rx="1.7" fill="#D8C8A2" />
          <path d="M6 5v6M8 5v6M10 5v6" stroke="#9B6B43" strokeWidth="0.9" />
        </svg>
      ) : (
        <SlidersHorizontal size={14} />
      )}
    </div>
  );
}

export function Inspector({ comp }: { comp: HwComponent }) {
  const { inspectorTab, setInspectorTab, selectedPin, selectPin, wires, selectComponent, removeComponent, setTool, startWire, openFile, addToast } = useStudio();
  const connected = wires.filter((w) => w.from.comp === comp.id || w.to.comp === comp.id);
  const selectedPinObj = comp.pins.find((p) => p.id === selectedPin);

  return (
    <motion.div
      key={comp.id}
      initial={{ opacity: 0, x: 10, scale: 0.992 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      className="absolute right-3 top-[54px] z-30 w-[292px] overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_0.5px_rgba(20,24,33,0.11),0_18px_46px_-14px_rgba(20,24,33,0.3),0_2px_6px_rgba(20,24,33,0.05)]"
    >
      <div className="flex items-start gap-2.5 px-3 pb-2.5 pt-3">
        <TypeGlyph kind={comp.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11.5px] font-semibold text-[#25292E]">{comp.name}</span>
            <span className="rounded-[3px] bg-[#F1F3F6] px-1 py-[1px] font-mono text-[8px] text-[#7A818A]">{comp.reference}</span>
          </div>
          <div className="mt-[3px] flex items-center gap-1.5 text-[9px] text-[#91969E]">
            <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
            {comp.kind === "board" ? "开发板定义 · 无真实连接" : "图中连线 · " + connected.length + " nets"}
            <span className="text-[#C5C8CD]">·</span>
            <span>3.3 V</span>
          </div>
        </div>
        <IconButton label="Close inspector" className="h-[22px] w-[22px]" onClick={() => selectComponent(null)}>
          <X size={12.5} />
        </IconButton>
      </div>

      <div className="flex h-[29px] items-end gap-4 border-b border-[#ECEEF1] px-3">
        {([
          ["properties", "Properties"],
          ["pins", "Pins " + (comp.kind === "board" ? comp.pins.length : comp.pins.length)],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setInspectorTab(id)}
            className={cn(
              "relative h-[28px] text-[10px] font-medium text-[#8A9098] transition-colors",
              inspectorTab === id && "text-[#1D1D1F]",
            )}
          >
            {label}
            {inspectorTab === id && <span className="absolute inset-x-0 bottom-0 h-[1.5px] rounded-full bg-[#007AFF]" />}
          </button>
        ))}
      </div>

      <div className="max-h-[268px] min-h-[150px] overflow-y-auto">
        {inspectorTab === "properties" ? (
          <div className="px-3 py-2">
            {Object.entries(comp.props).map(([key, value]) => (
              <div key={key} className="flex min-h-[26px] items-center gap-3 border-b border-[#F1F2F4] py-[5px] last:border-0">
                <span className="w-[74px] flex-none text-[9.5px] text-[#9499A1]">{key}</span>
                <span className="min-w-0 flex-1 text-right text-[10px] font-[450] leading-[1.45] text-[#3B4047]">{value}</span>
              </div>
            ))}
            <div className="mt-2 rounded-[6px] bg-[#F7F8FA] px-2.5 py-2 text-[9px] leading-[1.6] text-[#8C929A]">
              <span className="font-medium text-[#666D76]">{connected.length} connections</span> on the current bench. Drag the part to reposition it; wires follow automatically.
            </div>
          </div>
        ) : (
          <div className="py-1">
            {comp.pins.map((pin) => {
              const count = wires.filter(
                (w) => (w.from.comp === comp.id && w.from.pin === pin.id) || (w.to.comp === comp.id && w.to.pin === pin.id),
              ).length;
              return (
                <button
                  key={pin.id}
                  onClick={() => selectPin(comp.id, pin.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-[5px] text-left transition-colors hover:bg-[#F7F8FA]",
                    selectedPin === pin.id && "bg-[#F0F6FF]",
                  )}
                >
                  <span className="h-[5px] w-[5px] flex-none rounded-full" style={{ background: signalColor[pin.signal] ?? "#9BA1A8" }} />
                  <span className="w-[54px] flex-none font-mono text-[9px] font-medium text-[#3E444B]">{pin.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[9px] text-[#969CA4]">{pin.note ?? "Digital I/O"}</span>
                  {count > 0 ? (
                    <span className="flex items-center gap-0.5 text-[8.5px] tabular text-[#7B828B]"><Link2 size={8} />{count}</span>
                  ) : (
                    <span className="text-[8.5px] text-[#C0C4CA]">—</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedPinObj && (
        <div className="border-t border-[#ECEEF1] bg-[#FAFBFC] px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="text-[9px] text-[#8A9098]">Selected pin</div>
            <span className="font-mono text-[8.5px] text-[#6F7780]">{selectedPinObj.label}</span>
          </div>
          <div className="mt-1 text-[9.5px] leading-[1.5] text-[#555C65]">{selectedPinObj.note ?? "General purpose input / output"}</div>
          <button
            className="mt-1.5 flex h-[22px] items-center gap-1.5 rounded-[5px] border border-[#DDE1E6] bg-white px-2 text-[9px] font-medium text-[#4A515A] hover:bg-[#F6F8FA]"
            onClick={() => {
              setTool("wire");
              startWire(comp.id, selectedPinObj.id);
              addToast({ title: "Connection started", detail: "Pick a destination pin on the bench.", tone: "default" });
            }}
          >
            <Cable size={10.5} /> Connect this pin
          </button>
        </div>
      )}

      <div className="flex items-center gap-1.5 border-t border-[#ECEEF1] px-2.5 py-2">
        <button className="btn btn-ghost btn-sm h-[24px] px-1.5 text-[9.5px]" onClick={() => openFile(comp.kind === "board" ? "esp32_s3.board" : "circuit.json")}>
          <FileCode2 size={10.5} /> Open in files
        </button>
        <Tip label="Pin usage details" side="top">
          <button className="icon-btn ml-auto h-[23px] w-[23px]" onClick={() => addToast({ title: "尚未实现", detail: "电气规则校验尚未接入。", tone: "default" })}>
            <Info size={12} />
          </button>
        </Tip>
        {comp.kind !== "board" && (
          <Tip label="Remove component" side="top">
            <button className="icon-btn h-[23px] w-[23px] hover:bg-[#FCEFEC] hover:text-[#C14638]" onClick={() => removeComponent(comp.id)}>
              <Trash2 size={12} />
            </button>
          </Tip>
        )}
      </div>
    </motion.div>
  );
}
