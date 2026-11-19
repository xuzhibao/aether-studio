import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, CheckCircle2, ChevronRight, Radio } from "lucide-react";
import type { SerialLine } from "../types";
import { cn } from "../lib/utils";

const tone: Record<SerialLine["level"], string> = {
  info: "text-[#5F666E]",
  data: "text-[#2F6FA8]",
  success: "text-[#2B7F58]",
  warn: "text-[#A8741F]",
};

// A few pixels of rounding/slack still count as "at the bottom" so a real tail stays pinned.
const TAIL_THRESHOLD_PX = 8;

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
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The viewport can detach from the tail without changing the caller's follow intent.
  const [atTail, setAtTail] = useState(true);
  const filtered = filter === "all" ? lines : lines.filter((l) => l.level === (filter === "warn" ? "warn" : "data"));
  // Ring buffers replace rows at a constant length, so identity (not length) marks the tail.
  const tailId = filtered.length > 0 ? filtered[filtered.length - 1].id : "";
  // Resuming display or re-enabling Follow is an explicit request for live output.
  useEffect(() => { if (follow) setAtTail(true); }, [follow]);
  // An emptied or filtering-down view cannot hold a detached position; the next line should follow again.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && scroller.scrollHeight - scroller.clientHeight <= TAIL_THRESHOLD_PX) setAtTail(true);
  }, [filtered.length]);
  // Scroll only this list: scrollIntoView could move the parent panel or the page.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!follow || !atTail || !scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [follow, atTail, tailId, filtered.length]);
  const showJump = follow && !atTail && filtered.length > 0;
  const jumpToLatest = () => {
    const scroller = scrollerRef.current;
    setAtTail(true);
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollerRef}
        data-serial-scroller
        className={cn("h-full overflow-y-auto", compact ? "py-0.5" : "py-1")}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          setAtTail(distance <= TAIL_THRESHOLD_PX);
        }}
      >
        {filtered.map((line) => (
          <div
            key={line.id}
            data-serial-line={line.id}
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
      </div>
      {showJump && (
        <button
          type="button"
          aria-label="Jump to latest"
          title="跳回最新输出并继续跟随"
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full border border-[#DDE1E6] bg-white/95 px-2 py-[3px] text-[9.5px] text-[#47617D] shadow-sm hover:bg-[#F5F7F9]"
          onClick={jumpToLatest}
        >
          <ArrowDown size={10} /> Jump to latest
        </button>
      )}
    </div>
  );
}
