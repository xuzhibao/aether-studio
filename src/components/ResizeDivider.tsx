import { useCallback, useRef, useState } from "react";
import { cn } from "../lib/utils";

interface ResizeDividerProps {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  reverse?: boolean;
  onChange: (value: number) => void;
  className?: string;
}

export function ResizeDivider({ axis, value, min, max, reverse, onChange, className }: ResizeDividerProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, value });
  const latest = useRef(value);
  latest.current = value;

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      start.current = { pos: axis === "x" ? event.clientX : event.clientY, value: latest.current };
      setDragging(true);
      const move = (e: PointerEvent) => {
        const delta = (axis === "x" ? e.clientX : e.clientY) - start.current.pos;
        const next = start.current.value + (reverse ? -delta : delta);
        onChange(Math.min(max, Math.max(min, next)));
      };
      const up = () => {
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    },
    [axis, max, min, onChange, reverse],
  );

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      className={cn("resize-handle", axis === "x" ? "resize-x" : "resize-y", dragging && "dragging", className)}
    />
  );
}
