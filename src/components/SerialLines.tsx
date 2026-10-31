import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Radio } from "lucide-react";
import type { SerialLine } from "../types";
import { cn } from "../lib/utils";

const tone: Record<SerialLine["level"], string> = {
  info: "text-[#5F666E]",
  data: "text-[#2F6FA8]",
  success: "text-[#2B7F58]",
  warn: "text-[#A8741F]",
};

function LevelIcon({ level }: { level: SerialLine["level"] }) {
  if (level === "success") return <CheckCircle2 size={9.5} className="text-[#3B9A68]" />;
  if (level === "warn") return <AlertTriangle size={9.5} className="text-[#C08A2E]" />;
  if (level === "data") return <Radio size={9} className="text-[#4A86B8]" />;
  return <ChevronRight size={9.5} className="text-[#B0B5BC]" />;
}

export function SerialList({
  lines,
  compact,
  follow = true,
  showIcons = true,
  filter = "all",
}: {
  lines: SerialLine[];
  compact?: boolean;
  follow?: boolean;
  showIcons?: boolean;
  filter?: "all" | "data" | "warn";
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const filtered = filter === "all" ? lines : lines.filter((l) => l.level === (filter === "warn" ? "warn" : "data"));
  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [filtered.length, follow]);

  return (
    <div className={cn("h-full overflow-y-auto", compact ? "py-0.5" : "py-1")}>
      {filtered.map((line) => (
        <div
          key={line.id}
          className={cn(
            "group flex items-start gap-2 rounded-[4px] px-2 py-[2px] hover:bg-[#F5F7F9]",
            compact ? "text-[10px] leading-[18px]" : "text-[10.5px] leading-[19px]",
          )}
        >
          {showIcons && <span className="mt-[4px] flex-none opacity-80"><LevelIcon level={line.level} /></span>}
          <span className="serial-time flex-none pt-[0.5px] text-[#9299A2]">{line.time}</span>
          <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words font-mono", tone[line.level])}>{line.text}</span>
        </div>
      ))}
      {filtered.length === 0 && (
        <div className="flex h-full items-center justify-center px-4 text-center text-[10px] text-[#9AA0A8]">No serial output in this view.</div>
      )}
      {follow && <div ref={bottomRef} />}
    </div>
  );
}
