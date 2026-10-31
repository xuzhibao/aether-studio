import * as Tooltip from "@radix-ui/react-tooltip";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

export function Tip({ label, side = "bottom", children }: { label: ReactNode; side?: "top" | "bottom" | "left" | "right"; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={420}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={7}
          className="z-[120] rounded-[6px] bg-[#26282c] px-2 py-1 text-[10.5px] font-medium text-white shadow-lg"
        >
          {label}
          <Tooltip.Arrow className="fill-[#26282c]" width={9} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  side?: "top" | "bottom" | "left" | "right";
}

export function IconButton({ label, active, side = "bottom", className, children, ...props }: IconButtonProps) {
  return (
    <Tip label={label} side={side}>
      <button className={cn("icon-btn", active && "is-active", className)} aria-label={label} {...props}>
        {children}
      </button>
    </Tip>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function Dot({ tone = "green" }: { tone?: "green" | "amber" | "gray" | "red" }) {
  const color = tone === "green" ? "#2B9661" : tone === "amber" ? "#C08A2E" : tone === "red" ? "#D34A3D" : "#A0A5AC";
  return <span className="inline-block h-[5px] w-[5px] flex-none rounded-full" style={{ background: color }} />;
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="27" height="27" rx="7.2" fill="#1D1F23" />
      <rect x="0.5" y="0.5" width="27" height="27" rx="7.2" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
      <path d="M8.2 19.4L13.9 8.6L19.7 19.4" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.8 15.1H17.1" stroke="white" strokeWidth="1.7" strokeLinecap="round" opacity="0.82" />
      <circle cx="13.9" cy="8.6" r="2.2" fill="#0A84FF" />
      <circle cx="13.9" cy="8.6" r="0.9" fill="white" fillOpacity="0.92" />
    </svg>
  );
}

export function Spinner({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cn("spin-slow", className)}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.6" />
      <path d="M8 2C11.3137 2 14 4.68629 14 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("label-caps", className)}>{children}</div>;
}
