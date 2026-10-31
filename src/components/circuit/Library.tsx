import { useState } from "react";
import { motion } from "motion/react";
import {
  Cable,
  CircleDot,
  Cog,
  Droplets,
  Lightbulb,
  Monitor,
  Search,
  Thermometer,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import type { ComponentKind } from "../../types";
import { useStudio } from "../../store/studio";
import { cn } from "../../lib/utils";

const items: Array<{ kind: ComponentKind; name: string; meta: string; category: string; icon: typeof Thermometer; iconBg: string; iconColor: string }> = [
  { kind: "bme280", name: "BME280", meta: "Temp · humidity · pressure", category: "Sensors", icon: Thermometer, iconBg: "#EEF2F8", iconColor: "#46658C" },
  { kind: "dht22", name: "DHT22", meta: "Temp · humidity · 1-Wire", category: "Sensors", icon: Thermometer, iconBg: "#EEF6F1", iconColor: "#3E7D5D" },
  { kind: "soil", name: "Soil moisture", meta: "Capacitive · analog", category: "Sensors", icon: Droplets, iconBg: "#EDF4FA", iconColor: "#426F96" },
  { kind: "oled", name: "OLED 0.96″", meta: "SSD1306 · I²C", category: "Displays", icon: Monitor, iconBg: "#EDF3F8", iconColor: "#3E607F" },
  { kind: "led", name: "LED 5 mm", meta: "Red · 2.0 V", category: "Actuators", icon: Lightbulb, iconBg: "#FBF0ED", iconColor: "#B15B4D" },
  { kind: "buzzer", name: "Piezo buzzer", meta: "Passive · 2.7 kHz", category: "Actuators", icon: Volume2, iconBg: "#FBF4E9", iconColor: "#A8813B" },
  { kind: "servo", name: "Micro servo", meta: "SG90 · PWM", category: "Actuators", icon: Cog, iconBg: "#F1F0F9", iconColor: "#6C5DA8" },
  { kind: "button", name: "Push button", meta: "Momentary · THT", category: "Passives", icon: CircleDot, iconBg: "#F2F3F5", iconColor: "#5F6770" },
  { kind: "resistor", name: "Resistor", meta: "220 Ω · 0.25 W", category: "Passives", icon: Cable, iconBg: "#F8F4EA", iconColor: "#99783E" },
];

const categories = ["All", "Sensors", "Displays", "Actuators", "Passives"];

export function ComponentLibrary() {
  const { setLibraryOpen, addComponent, setTool } = useStudio();
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const filtered = items.filter(
    (item) =>
      (category === "All" || item.category === category) &&
      (item.name.toLowerCase().includes(query.toLowerCase()) || item.meta.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: 10, scale: 0.99 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
      className="absolute right-3 top-[54px] z-30 flex max-h-[440px] w-[334px] flex-col overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_0.5px_rgba(20,24,33,0.11),0_18px_46px_-14px_rgba(20,24,33,0.3),0_2px_6px_rgba(20,24,33,0.05)]"
    >
      <div className="flex items-start justify-between px-3 pb-2 pt-3">
        <div>
          <div className="text-[11.5px] font-semibold text-[#25292E]">Component Library</div>
          <div className="mt-0.5 text-[9px] text-[#9298A0]">Add a part to the virtual bench</div>
        </div>
        <button className="icon-btn h-[22px] w-[22px]" onClick={() => { setLibraryOpen(false); setTool("select"); }}>
          <X size={12.5} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex h-[28px] items-center gap-1.5 rounded-[6px] border border-[#E2E5EA] bg-[#FAFBFC] px-2 focus-within:border-[#B8D7FB] focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(0,122,255,0.07)]">
          <Search size={11.5} className="text-[#9AA0A8]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search components…"
            className="w-full bg-transparent text-[10.5px] text-[#33383E] outline-none placeholder:text-[#A6ABB2]"
          />
          <span className="kbd">9</span>
        </div>
      </div>

      <div className="flex flex-none gap-1 overflow-x-auto px-3 pb-2 no-scrollbar">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={cn(
              "h-[21px] flex-none rounded-[4.5px] px-1.5 text-[9px] font-medium text-[#8A9098] transition-colors hover:bg-[#F3F5F7]",
              category === cat && "bg-[#EEF1F4] text-[#3D434A]",
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="grid grid-cols-2 gap-1.5">
          {filtered.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.kind}
                onClick={() => addComponent(item.kind)}
                className="group flex items-start gap-2 rounded-[7px] border border-[#EAECEF] bg-[#FCFCFD] p-2 text-left transition-all hover:border-[#C9DDF7] hover:bg-[#F8FBFF] hover:shadow-[0_2px_8px_-4px_rgba(20,24,33,0.16)]"
              >
                <span className="flex h-[27px] w-[27px] flex-none items-center justify-center rounded-[6px]" style={{ background: item.iconBg, color: item.iconColor }}>
                  <Icon size={13.5} strokeWidth={1.7} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[10px] font-[520] text-[#343940]">{item.name}</span>
                  <span className="mt-0.5 block truncate text-[8px] leading-[1.25] text-[#9AA0A8]">{item.meta}</span>
                </span>
              </button>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <div className="flex h-[90px] items-center justify-center text-[10px] text-[#9AA0A8]">No components match “{query}”</div>
        )}
      </div>

      <div className="flex flex-none items-center gap-1.5 border-t border-[#EEF0F3] bg-[#FAFBFC] px-3 py-2 text-[8.5px] text-[#9AA0A8]">
        <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
        Click a part to place it · 3.3 V logic
        <span className="ml-auto tabular">{filtered.length} parts</span>
      </div>
    </motion.div>
  );
}
