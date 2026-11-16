export type ComponentKind = string;

export type PinSignal = "power" | "gnd" | "i2c" | "gpio" | "analog" | "pwm";
export type PinDir = "left" | "right" | "up" | "down";

export interface Pin {
  id: string;
  label: string;
  x: number;
  y: number;
  dir: PinDir;
  signal: PinSignal;
  note?: string;
}

export interface HwComponent {
  id: string;
  kind: ComponentKind;
  name: string;
  reference: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  pins: Pin[];
  props: Record<string, string>;
}

export type WireSignal = "power" | "gnd" | "sda" | "scl" | "gpio";

export interface Wire {
  id: string;
  from: { comp: string; pin: string };
  to: { comp: string; pin: string };
  signal: WireSignal;
  color: string;
  lane?: number;
}

export type RunState = "idle" | "running" | "paused";

export interface SerialLine {
  id: string;
  time: string;
  level: "info" | "data" | "success" | "warn";
  text: string;
}

export interface ConsoleLine {
  id: string;
  source: "Build" | "Agent" | "Simulator" | "Deploy";
  text: string;
  tone?: "normal" | "muted" | "success" | "warn";
}

export interface Step {
  id: string;
  label: string;
  detail?: string;
  state: "pending" | "active" | "done";
}

export interface AgentRef {
  kind: "file" | "part" | "pin";
  label: string;
  target?: string;
  meta?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "agent";
  time: string;
  text: string;
  steps?: Step[];
  refs?: AgentRef[];
  summary?: string;
  actions?: boolean;
  live?: boolean;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  board: string;
  updated: string;
  accent: string;
  template: string;
}

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  tone?: "default" | "success" | "warn";
}

export type Tool = "select" | "wire" | "add" | "inspect";
export type ViewMode = "board" | "schematic";
export type DockTab = "code" | "serial" | "console" | "variables" | "logic" | "performance";
