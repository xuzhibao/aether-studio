import { create } from "zustand";
import type {
  AgentMessage,
  ComponentKind,
  ConsoleLine,
  DockTab,
  HwComponent,
  ProjectMeta,
  RunState,
  SerialLine,
  Step,
  Toast,
  Tool,
  ViewMode,
  Wire,
} from "../types";
import {
  board,
  initialAgentMessages,
  initialComponents,
  initialConsole,
  initialFiles,
  initialSerial,
  initialWires,
  projects as seedProjects,
} from "../data/mock";
import { clamp, simTime, uid } from "../lib/utils";

export type DialogKind = "new-project" | "deploy" | "devices" | "tests" | "overview" | null;

interface WorkspaceSnapshot {
  components: HwComponent[];
  wires: Wire[];
  files: Record<string, string>;
}

interface NewProjectInput {
  name: string;
  board: string;
  template: string;
}

interface StudioState {
  projects: ProjectMeta[];
  activeProjectId: string;
  workspaces: Record<string, WorkspaceSnapshot>;
  components: HwComponent[];
  wires: Wire[];
  files: Record<string, string>;

  activeNav: string;
  activeTab: string;
  openTabs: string[];
  dirty: boolean;

  sidebarCollapsed: boolean;
  sidebarWidth: number;
  agentWidth: number;
  agentCollapsed: boolean;
  dockOpen: boolean;
  dockHeight: number;
  dockTab: DockTab;
  splitMode: boolean;

  selectedId: string | null;
  selectedPin: string | null;
  inspectorTab: "properties" | "pins";
  tool: Tool;
  viewMode: ViewMode;
  wireStart: { comp: string; pin: string } | null;
  zoom: number;
  pan: { x: number; y: number };
  libraryOpen: boolean;

  runState: RunState;
  elapsed: number;
  readings: { temperature: number; humidity: number; pressure: number };
  ledOn: boolean;
  serial: SerialLine[];
  console: ConsoleLine[];
  errors: number;
  warnings: number;
  cpu: number;
  memory: number;
  deviceConnected: boolean;

  agentMessages: AgentMessage[];
  agentRunning: boolean;
  agentDraft: string;
  aiModifiedFiles: string[];
  appliedFixIds: string[];

  dialog: DialogKind;
  commandOpen: boolean;
  toasts: Toast[];
  settings: { reducedMotion: boolean; autopilot: boolean; fontSize: number };

  setActiveNav: (nav: string) => void;
  setTab: (tab: string) => void;
  openFile: (file: string) => void;
  closeTab: (tab: string) => void;
  updateFile: (name: string, value: string) => void;
  saveProject: () => void;

  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (v: number) => void;
  setAgentWidth: (v: number) => void;
  setAgentCollapsed: (v: boolean) => void;
  setDockOpen: (v: boolean) => void;
  setDockHeight: (v: number) => void;
  setDockTab: (tab: DockTab) => void;
  setSplitMode: (v: boolean) => void;

  selectComponent: (id: string | null) => void;
  selectPin: (comp: string, pin: string) => void;
  setInspectorTab: (tab: "properties" | "pins") => void;
  setTool: (tool: Tool) => void;
  setViewMode: (mode: ViewMode) => void;
  setZoom: (z: number) => void;
  setPan: (p: { x: number; y: number }) => void;
  resetView: () => void;
  moveComponent: (id: string, x: number, y: number) => void;
  addComponent: (kind: ComponentKind) => void;
  removeComponent: (id: string) => void;
  startWire: (comp: string, pin: string) => void;
  completeWire: (comp: string, pin: string) => void;
  cancelWire: () => void;
  setLibraryOpen: (v: boolean) => void;
  setDialog: (dialog: DialogKind) => void;
  setCommandOpen: (v: boolean) => void;

  setRunState: (state: RunState) => void;
  runSimulation: () => void;
  pauseSimulation: () => void;
  resetSimulation: () => void;
  tick: () => void;
  build: () => void;
  deployDone: () => void;

  setAgentDraft: (v: string) => void;
  runAgent: (prompt?: string) => Promise<void>;
  applyFix: (messageId: string) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  createProject: (input: NewProjectInput) => void;
  switchProject: (id: string) => void;
  updateSettings: (partial: Partial<StudioState["settings"]>) => void;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const colorBySignal = {
  power: "#E15B4F",
  gnd: "#41464F",
  i2c: "#2F7FD8",
  gpio: "#3B9A68",
  analog: "#8A6DCC",
  pwm: "#D9962F",
};

function makePart(kind: ComponentKind, index: number): HwComponent {
  const base = {
    id: uid(kind),
    kind,
    x: 760 + (index % 2) * 0,
    y: 540,
    props: {} as Record<string, string>,
  };
  switch (kind) {
    case "bme280":
      return {
        ...base,
        name: "BME280 Sensor",
        reference: "U" + (2 + index),
        x: 420 + (index % 2) * 24,
        y: 55,
        w: 170,
        h: 122,
        pins: [
          { id: "vin", label: "VIN", signal: "power", x: 178, y: 34, dir: "right" },
          { id: "gnd", label: "GND", signal: "gnd", x: 178, y: 54, dir: "right" },
          { id: "sda", label: "SDA", signal: "i2c", x: 178, y: 74, dir: "right" },
          { id: "scl", label: "SCL", signal: "i2c", x: 178, y: 94, dir: "right" },
        ],
        props: { Interface: "I²C", Address: "0x76", Range: "300–1100 hPa" },
      };
    case "oled":
      return {
        ...base,
        name: "OLED 0.96″",
        reference: "DS" + (1 + index),
        x: 420 + (index % 2) * 24,
        y: 46,
        w: 204,
        h: 136,
        pins: [
          { id: "gnd", label: "GND", signal: "gnd", x: 48, y: 144, dir: "down" },
          { id: "vcc", label: "VCC", signal: "power", x: 88, y: 144, dir: "down" },
          { id: "scl", label: "SCL", signal: "i2c", x: 128, y: 144, dir: "down" },
          { id: "sda", label: "SDA", signal: "i2c", x: 168, y: 144, dir: "down" },
        ],
        props: { Controller: "SSD1306", Resolution: "128 × 64", Interface: "I²C · 0x3C" },
      };
    case "resistor":
      return {
        ...base,
        name: "Resistor 220 Ω",
        reference: "R" + (1 + index),
        x: 360 + (index % 3) * 24,
        y: 600,
        w: 78,
        h: 24,
        pins: [
          { id: "p1", label: "1", signal: "gpio", x: 0, y: 12, dir: "left" },
          { id: "p2", label: "2", signal: "gpio", x: 78, y: 12, dir: "right" },
        ],
        props: { Value: "220 Ω", Tolerance: "±1%", Package: "Axial" },
      };
    case "led":
      return {
        ...base,
        name: "Status LED",
        reference: "D" + (1 + index),
        x: 420 + (index % 3) * 24,
        y: 600,
        w: 44,
        h: 48,
        pins: [
          { id: "a", label: "A", signal: "gpio", x: 0, y: 24, dir: "left" },
          { id: "k", label: "K", signal: "gnd", x: 44, y: 24, dir: "right" },
        ],
        props: { Color: "Red · 625 nm", Forward: "2.0 V", Lens: "5 mm" },
      };
    case "buzzer":
      return {
        ...base,
        name: "Piezo Buzzer",
        reference: "BZ" + (1 + index),
        x: 360 + (index % 3) * 24,
        y: 588,
        w: 64,
        h: 64,
        pins: [
          { id: "p", label: "+", signal: "pwm", x: 0, y: 40, dir: "left" },
          { id: "n", label: "−", signal: "gnd", x: 64, y: 40, dir: "right" },
        ],
        props: { Voltage: "3–5 V", Frequency: "2.7 kHz", Type: "Passive" },
      };
    case "button":
      return {
        ...base,
        name: "Push Button",
        reference: "SW" + (1 + index),
        x: 420 + (index % 3) * 24,
        y: 588,
        w: 58,
        h: 58,
        pins: [
          { id: "p1", label: "1", signal: "gpio", x: 0, y: 34, dir: "left" },
          { id: "p2", label: "2", signal: "gnd", x: 58, y: 34, dir: "right" },
        ],
        props: { Type: "Momentary", Mounting: "THT", Rating: "12 V / 50 mA" },
      };
    case "dht22":
      return {
        ...base,
        name: "DHT22 Sensor",
        reference: "U" + (2 + index),
        x: 430 + (index % 2) * 24,
        y: 55,
        w: 86,
        h: 116,
        pins: [
          { id: "vcc", label: "VCC", signal: "power", x: 18, y: 124, dir: "down" },
          { id: "data", label: "DATA", signal: "gpio", x: 43, y: 124, dir: "down" },
          { id: "gnd", label: "GND", signal: "gnd", x: 68, y: 124, dir: "down" },
        ],
        props: { Interface: "1-Wire", Range: "−40–80 °C", Accuracy: "±0.5 °C" },
      };
    case "soil":
      return {
        ...base,
        name: "Soil Moisture",
        reference: "U" + (2 + index),
        x: 430 + (index % 2) * 24,
        y: 50,
        w: 96,
        h: 132,
        pins: [
          { id: "vcc", label: "VCC", signal: "power", x: 20, y: 140, dir: "down" },
          { id: "ao", label: "AO", signal: "analog", x: 48, y: 140, dir: "down" },
          { id: "gnd", label: "GND", signal: "gnd", x: 76, y: 140, dir: "down" },
        ],
        props: { Output: "Analog", Range: "0–3.0 V", Probe: "Capacitive" },
      };
    case "servo":
      return {
        ...base,
        name: "Micro Servo",
        reference: "M" + (1 + index),
        x: 420 + (index % 2) * 24,
        y: 585,
        w: 92,
        h: 92,
        pins: [
          { id: "sig", label: "SIG", signal: "pwm", x: 92, y: 58, dir: "right" },
          { id: "vcc", label: "V+", signal: "power", x: 92, y: 72, dir: "right" },
          { id: "gnd", label: "GND", signal: "gnd", x: 92, y: 86, dir: "right" },
        ],
        props: { Torque: "1.8 kg·cm", Voltage: "4.8–6 V", Signal: "PWM 50 Hz" },
      };
    default:
      return clone(board);
  }
}

const navForTab = (tab: string) => {
  if (tab === "circuit") return "circuit";
  if (tab === "serial") return "simulation";
  return "source";
};

const baseWorkspace = (): WorkspaceSnapshot => ({
  components: clone(initialComponents),
  wires: clone(initialWires),
  files: clone(initialFiles),
});

export const useStudio = create<StudioState>((set, get) => ({
  projects: clone(seedProjects),
  activeProjectId: "env-monitor",
  workspaces: { "env-monitor": baseWorkspace() },
  components: clone(initialComponents),
  wires: clone(initialWires),
  files: clone(initialFiles),

  activeNav: "circuit",
  activeTab: "circuit",
  openTabs: ["circuit", "main.py", "sensors.py", "serial"],
  dirty: false,

  sidebarCollapsed: false,
  sidebarWidth: 238,
  agentWidth: 366,
  agentCollapsed: false,
  dockOpen: true,
  dockHeight: 218,
  dockTab: "code",
  splitMode: false,

  selectedId: null,
  selectedPin: null,
  inspectorTab: "properties",
  tool: "select",
  viewMode: "board",
  wireStart: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  libraryOpen: false,

  runState: "running",
  elapsed: 102,
  readings: { temperature: 24.6, humidity: 48.2, pressure: 1013.2 },
  ledOn: true,
  serial: clone(initialSerial),
  console: clone(initialConsole),
  errors: 0,
  warnings: 2,
  cpu: 38,
  memory: 38,
  deviceConnected: true,

  agentMessages: clone(initialAgentMessages),
  agentRunning: false,
  agentDraft: "",
  aiModifiedFiles: [],
  appliedFixIds: [],

  dialog: null,
  commandOpen: false,
  toasts: [],
  settings: { reducedMotion: false, autopilot: true, fontSize: 12.5 },

  setActiveNav: (nav) => {
    set({ activeNav: nav });
    if (nav === "overview") set({ dialog: "overview" });
    if (nav === "hardware") {
      set({ activeTab: "circuit", selectedId: "board-1", tool: "select" });
    }
    if (nav === "circuit") set({ activeTab: "circuit" });
    if (nav === "source") get().openFile("main.py");
    if (nav === "components") set({ activeTab: "circuit", libraryOpen: true });
    if (nav === "simulation") set({ activeTab: "serial" });
    if (nav === "devices") set({ dialog: "devices" });
    if (nav === "tests") set({ dialog: "tests" });
  },
  setTab: (tab) => set({ activeTab: tab, activeNav: navForTab(tab), libraryOpen: false }),
  openFile: (file) => {
    set((s) => ({
      activeTab: file,
      activeNav: navForTab(file),
      openTabs: s.openTabs.includes(file) ? s.openTabs : [...s.openTabs, file],
      libraryOpen: false,
    }));
  },
  closeTab: (tab) => {
    if (tab === "circuit" || tab === "serial") return;
    set((s) => {
      const tabs = s.openTabs.filter((t) => t !== tab);
      return {
        openTabs: tabs,
        activeTab: s.activeTab === tab ? tabs[tabs.length - 1] ?? "circuit" : s.activeTab,
      };
    });
  },
  updateFile: (name, value) =>
    set((s) => ({
      files: { ...s.files, [name]: value },
      dirty: true,
      aiModifiedFiles: s.aiModifiedFiles,
    })),
  saveProject: () => {
    set({ dirty: false });
    get().addToast({ title: "Project saved", detail: "All changes synced locally", tone: "success" });
  },

  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  setSidebarWidth: (v) => set({ sidebarWidth: clamp(v, 208, 304) }),
  setAgentWidth: (v) => set({ agentWidth: clamp(v, 316, 470) }),
  setAgentCollapsed: (v) => set({ agentCollapsed: v }),
  setDockOpen: (v) => set({ dockOpen: v }),
  setDockHeight: (v) => set({ dockHeight: clamp(v, 128, 360) }),
  setDockTab: (tab) => set({ dockTab: tab, dockOpen: true }),
  setSplitMode: (v) => set({ splitMode: v }),

  selectComponent: (id) =>
    set({ selectedId: id, inspectorTab: "properties", libraryOpen: false, selectedPin: null }),
  selectPin: (comp, pin) => {
    const s = get();
    if (s.tool === "wire") {
      if (!s.wireStart) s.startWire(comp, pin);
      else s.completeWire(comp, pin);
    } else {
      set({ selectedId: comp, selectedPin: pin, inspectorTab: "pins" });
    }
  },
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  setTool: (tool) => set({ tool, wireStart: null, libraryOpen: tool === "add" ? true : get().libraryOpen }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setZoom: (z) => set({ zoom: clamp(z, 0.6, 2) }),
  setPan: (p) => set({ pan: p }),
  resetView: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
  moveComponent: (id, x, y) =>
    set((s) => ({
      components: s.components.map((c) => (c.id === id ? { ...c, x, y } : c)),
      dirty: true,
    })),
  addComponent: (kind) => {
    const count = get().components.filter((c) => c.kind === kind).length;
    const part = makePart(kind, count);
    set((s) => ({
      components: [...s.components, part],
      selectedId: part.id,
      tool: "select",
      libraryOpen: false,
      activeTab: "circuit",
      activeNav: "circuit",
      dirty: true,
    }));
    get().addToast({ title: part.name + " added", detail: "Drag it onto the bench to place", tone: "success" });
  },
  removeComponent: (id) => {
    if (id === "board-1") return;
    set((s) => ({
      components: s.components.filter((c) => c.id !== id),
      wires: s.wires.filter((w) => w.from.comp !== id && w.to.comp !== id),
      selectedId: null,
      dirty: true,
    }));
    get().addToast({ title: "Component removed", tone: "default" });
  },
  startWire: (comp, pin) => set({ wireStart: { comp, pin }, selectedPin: pin }),
  completeWire: (comp, pin) => {
    const start = get().wireStart;
    if (!start) return;
    if (start.comp === comp && start.pin === pin) {
      set({ wireStart: null });
      return;
    }
    const fromComp = get().components.find((c) => c.id === start.comp);
    const fromPin = fromComp?.pins.find((p) => p.id === start.pin);
    if (!fromComp || !fromPin) return;
    const signal =
      fromPin.signal === "power"
        ? "power"
        : fromPin.signal === "gnd"
          ? "gnd"
          : fromPin.signal === "i2c"
            ? start.pin === "l11" || start.pin === "sda"
              ? "sda"
              : "scl"
            : "gpio";
    const wire: Wire = {
      id: uid("wire"),
      from: start,
      to: { comp, pin },
      signal,
      color: colorBySignal[fromPin.signal] ?? "#41464F",
      lane: get().wires.length % 6,
    };
    set((s) => ({ wires: [...s.wires, wire], wireStart: null, selectedPin: null, dirty: true }));
    get().addToast({ title: "Connection added", detail: fromPin.label + " → " + pin.toUpperCase(), tone: "success" });
  },
  cancelWire: () => set({ wireStart: null, selectedPin: null }),
  setLibraryOpen: (v) => set({ libraryOpen: v }),
  setDialog: (dialog) => set({ dialog }),
  setCommandOpen: (v) => set({ commandOpen: v }),

  setRunState: (state) => set({ runState: state }),
  runSimulation: () => {
    if (get().runState === "running") {
      get().addToast({ title: "Simulation already running", detail: "Use Pause to inspect state", tone: "default" });
      return;
    }
    set({ runState: "running" });
    get().addToast({ title: "Simulation resumed", detail: "Virtual ESP32-S3 · COM3", tone: "success" });
  },
  pauseSimulation: () => {
    if (get().runState !== "running") return;
    set({ runState: "paused" });
    get().addToast({ title: "Simulation paused", detail: "Execution halted at 400 kHz I²C", tone: "default" });
  },
  resetSimulation: () => {
    set({
      runState: "running",
      elapsed: 0,
      readings: { temperature: 24.1, humidity: 47.6, pressure: 1013.4 },
      ledOn: false,
      serial: [
        { id: uid("s"), time: simTime(0), level: "info", text: "Soft reset · ESP32-S3 · MicroPython v1.23.0" },
        { id: uid("s"), time: simTime(0, 240), level: "info", text: "BME280 initialized · addr 0x76" },
        { id: uid("s"), time: simTime(0, 420), level: "success", text: "SSD1306 display initialized · 128×64" },
      ],
      console: [
        ...get().console,
        { id: uid("c"), source: "Simulator", text: "Board reset · runtime restarted from boot.py", tone: "muted" },
      ],
      cpu: 31,
      memory: 34,
    });
    get().addToast({ title: "Simulation reset", detail: "Runtime restarted from boot", tone: "default" });
  },
  tick: () => {
    const s = get();
    if (s.runState !== "running") return;
    const elapsed = s.elapsed + 1;
    const base = { runState: s.runState, elapsed, cpu: clamp(32 + Math.round(Math.random() * 16), 24, 58), memory: clamp(37 + Math.round(Math.random() * 3), 34, 46) } as Partial<StudioState>;
    if (elapsed % 2 === 0) {
      const t = clamp(s.readings.temperature + (Math.random() - 0.49) * 0.12, 23.9, 25.3);
      const h = clamp(s.readings.humidity + (Math.random() - 0.5) * 0.3, 46.4, 50.1);
      const p = clamp(s.readings.pressure + (Math.random() - 0.5) * 0.2, 1012.4, 1014.2);
      const readings = { temperature: Number(t.toFixed(1)), humidity: Number(h.toFixed(1)), pressure: Number(p.toFixed(1)) };
      const sample = "Temperature: " + readings.temperature.toFixed(1) + " °C   Humidity: " + readings.humidity.toFixed(1) + " %   " + readings.pressure.toFixed(1) + " hPa";
      const lines: SerialLine[] = [
        { id: uid("s"), time: simTime(elapsed), level: "info", text: sample },
        { id: uid("s"), time: simTime(elapsed, 28), level: "info", text: "OLED updated successfully · frame " + Math.floor(elapsed / 2) + " · " + (6 + Math.floor(Math.random() * 6)) + " ms" },
      ];
      if (elapsed % 10 === 0) {
        lines.push({ id: uid("s"), time: simTime(elapsed, 140), level: "data", text: "sample → aether/env-monitor · 62 B · " + (34 + Math.floor(Math.random() * 18)) + " ms" });
      }
      if (elapsed % 34 === 0) {
        lines.push({ id: uid("s"), time: simTime(elapsed, 220), level: "warn", text: "I²C clock stretch 1.6 ms exceeds 1.0 ms budget (recovered)" });
      }
      set({ ...base, readings, ledOn: !s.ledOn, serial: [...s.serial, ...lines].slice(-90) });
    } else {
      set(base);
    }
  },
  build: () => {
    if (get().runState === "running") set({ runState: "paused" });
    const line: ConsoleLine = { id: uid("c"), source: "Build", text: "Compiling firmware · main.py · sensors.py", tone: "muted" };
    set((s) => ({ console: [...s.console, line], cpu: 72 }));
    get().addToast({ title: "Building firmware", detail: "MicroPython · ESP32-S3", tone: "default" });
    window.setTimeout(() => {
      set((s) => ({
        cpu: 38,
        console: [
          ...s.console,
          { id: uid("c"), source: "Build", text: "Build succeeded · 1.42 s · 0 errors, 2 warnings", tone: "success" },
        ],
      }));
      get().addToast({ title: "Build succeeded", detail: "Ready to deploy · 2 warnings", tone: "success" });
    }, 1600);
  },
  deployDone: () => {
    set((s) => ({
      deviceConnected: true,
      console: [
        ...s.console,
        { id: uid("c"), source: "Deploy", text: "Flashed 1.2 MB to ESP32-S3 via USB-C · verified", tone: "success" },
      ],
    }));
    get().addToast({ title: "Deployed to ESP32-S3", detail: "Firmware verified · device rebooted", tone: "success" });
  },

  setAgentDraft: (v) => set({ agentDraft: v }),
  runAgent: async (prompt) => {
    const text = (prompt ?? get().agentDraft).trim();
    if (!text || get().agentRunning) return;
    const lower = text.toLowerCase();
    const isDebug = /error|debug|warning|fix|i2c|clock/i.test(lower);
    const isSleep = /sleep|battery|power|低功耗/i.test(lower);
    const isExplain = /explain|why|what|how|解释|为什么/i.test(lower);
    const isLed = /led|blink|indicator|灯/i.test(lower);

    let steps: Step[];
    let summary: string;
    let refs: AgentMessage["refs"];
    if (isExplain) {
      steps = [
        { id: uid("st"), label: "Reading circuit graph", detail: "5 components · 5 nets", state: "pending" },
        { id: uid("st"), label: "Inspecting firmware", detail: "main.py · sensors.py", state: "pending" },
        { id: uid("st"), label: "Tracing I²C transactions", detail: "GPIO 8 / GPIO 9", state: "pending" },
      ];
      summary = "The BME280 and SSD1306 share I²C bus 0 on GPIO 8 (SDA) and GPIO 9 (SCL). Both devices sit on 3.3 V, with the OLED daisy-chained from the same net. The firmware samples every 2 seconds and pushes a full frame to the display.";
      refs = [
        { kind: "part", label: "BME280", target: "sensor-bme280" },
        { kind: "part", label: "SSD1306", target: "display-oled" },
        { kind: "file", label: "main.py", target: "main.py" },
      ];
    } else if (isSleep) {
      steps = [
        { id: uid("st"), label: "Analyzing power budget", detail: "Active 42 mA · sleep target < 200 µA", state: "pending" },
        { id: uid("st"), label: "Added deep-sleep schedule", detail: "10 s light sleep between samples", state: "pending" },
        { id: uid("st"), label: "Updated firmware entrypoint", detail: "main.py", state: "pending" },
        { id: uid("st"), label: "Rebuilding firmware", detail: "MicroPython · ESP32-S3", state: "pending" },
        { id: uid("st"), label: "Verifying wake source", detail: "Timer wake · GPIO 0 armed", state: "pending" },
      ];
      summary = "I moved the sampling loop to a 10-second timer wake and put the radio into light sleep between reads. Estimated runtime on a 2 000 mAh cell is now roughly 38 hours.";
      refs = [
        { kind: "file", label: "main.py", target: "main.py", meta: "+9 −1" },
        { kind: "file", label: "config.json", target: "config.json", meta: "+2 −2" },
      ];
    } else if (isDebug) {
      steps = [
        { id: uid("st"), label: "Read serial output", detail: "1 warning · clock stretch 1.8 ms", state: "pending" },
        { id: uid("st"), label: "Located I²C timing issue", detail: "400 kHz exceeds peripheral budget", state: "pending" },
        { id: uid("st"), label: "Reduced bus to 100 kHz", detail: "sensors.py · i2c.freq", state: "pending" },
        { id: uid("st"), label: "Reran simulation · 30 s", detail: "0 warnings", state: "pending" },
      ];
      summary = "The warning came from a 1.8 ms clock stretch on the OLED during page updates. Dropping the bus to 100 kHz removed the contention; 30 seconds of samples passed with no warnings.";
      refs = [
        { kind: "file", label: "sensors.py", target: "sensors.py", meta: "+3 −1" },
        { kind: "pin", label: "GPIO 9 · SCL", meta: "100 kHz" },
      ];
    } else {
      steps = [
        { id: uid("st"), label: "Parsed engineering request", detail: "Scope: circuit · firmware · simulation", state: "pending" },
        { id: uid("st"), label: "Inspected current bench", detail: "5 components · 11 connections", state: "pending" },
        { id: uid("st"), label: isLed ? "Mapped LED to GPIO 2" : "Planned implementation", detail: isLed ? "R1 220 Ω → D1" : "No structural changes", state: "pending" },
        { id: uid("st"), label: "Applied firmware patch", detail: "main.py", state: "pending" },
        { id: uid("st"), label: "Rebuilt and simulated", detail: "30 s · COM3", state: "pending" },
        { id: uid("st"), label: "Verification passed", detail: "0 errors · 0 dropped samples", state: "pending" },
      ];
      summary = isLed
        ? "The status LED is bound to GPIO 2 through the 220 Ω resistor. I set it to toggle once per successful sample and left the PWM fallback available in the firmware."
        : "I applied the requested change to the project, rebuilt the firmware and ran a 30-second simulation. The circuit stayed stable and all samples reached the OLED and MQTT bridge.";
      refs = [{ kind: "file", label: "main.py", target: "main.py", meta: "+6 −2" }];
    }

    const userId = uid("msg");
    const agentId = uid("msg");
    const activeSteps = steps.map((step, index) => ({ ...step, state: index === 0 ? "active" : "pending" })) as Step[];
    const userMessage: AgentMessage = { id: userId, role: "user", time: "now", text };
    const agentMessage: AgentMessage = {
      id: agentId,
      role: "agent",
      time: "now",
      text: "On it. I'll inspect the bench, make the change and verify it in simulation.",
      steps: activeSteps,
      refs,
      summary,
      actions: true,
      live: false,
    };
    set((s) => ({
      agentRunning: true,
      agentDraft: "",
      agentMessages: [...s.agentMessages.map((m) => ({ ...m, live: false })), userMessage, agentMessage],
    }));

    for (let i = 0; i < activeSteps.length; i++) {
      await sleep(520 + Math.random() * 260);
      set((s) => ({
        agentMessages: s.agentMessages.map((m) => {
          if (m.id !== agentId || !m.steps) return m;
          return {
            ...m,
            steps: m.steps.map((step, index) => ({
              ...step,
              state: index <= i ? "done" : index === i + 1 ? "active" : "pending",
            })) as Step[],
          };
        }),
      }));
    }

    await sleep(420);
    const contentUpdates: Record<string, string> = {};
    if (isSleep) {
      contentUpdates["main.py"] = get()
        .files["main.py"].replace(
          "        sample += 1\n        time.sleep_ms(SAMPLE_INTERVAL_MS)",
          "        sample += 1\n        # Aether: radio and OLED enter light sleep between samples\n        machine.deepsleep(SAMPLE_INTERVAL_MS)",
        )
        .replace("SAMPLE_INTERVAL_MS = 2000", "SAMPLE_INTERVAL_MS = 10000");
      contentUpdates["config.json"] = get().files["config.json"].replace('"interval_ms": 2000', '"interval_ms": 10000');
    } else if (isDebug) {
      contentUpdates["sensors.py"] = "# Aether: guard against clock stretching on long OLED frames\n" + get().files["sensors.py"];
    } else if (!isExplain) {
      contentUpdates["main.py"] = get().files["main.py"].replace(
        "SAMPLE_INTERVAL_MS = 2000",
        "SAMPLE_INTERVAL_MS = 2000\n# Aether: patch applied and verified in simulation",
      );
    }

    set((s) => ({
      agentRunning: false,
      files: { ...s.files, ...contentUpdates },
      aiModifiedFiles: Array.from(new Set([...s.aiModifiedFiles, ...Object.keys(contentUpdates)])),
      dirty: Object.keys(contentUpdates).length > 0 ? true : s.dirty,
      agentMessages: s.agentMessages.map((m) => (m.id === agentId ? { ...m, live: true } : m)),
      serial: [
        ...s.serial,
        { id: uid("s"), time: simTime(s.elapsed + 1), level: "success" as const, text: "Aether Agent · patch verified · 30 / 30 samples stable" },
      ].slice(-90),
      console: [
        ...s.console,
        { id: uid("c"), source: "Agent", text: "Applied patch · rebuilt · simulation passed (30 s)", tone: "success" },
      ],
      cpu: 44,
    }));
    get().addToast({ title: "Agent finished", detail: "Changes verified in simulation", tone: "success" });
  },
  applyFix: (messageId) => {
    if (get().appliedFixIds.includes(messageId)) return;
    const sensors = get().files["sensors.py"];
    const updated = "# Aether: I²C timing fix — cap the bus at 100 kHz for long OLED frames\n" + sensors;
    set((s) => ({
      files: { ...s.files, "sensors.py": updated },
      dirty: true,
      warnings: 0,
      aiModifiedFiles: Array.from(new Set([...s.aiModifiedFiles, "sensors.py"])),
      appliedFixIds: [...s.appliedFixIds, messageId],
      activeTab: "sensors.py",
      activeNav: "source",
      openTabs: s.openTabs.includes("sensors.py") ? s.openTabs : [...s.openTabs, "sensors.py"],
      console: [
        ...s.console,
        { id: uid("c"), source: "Agent", text: "Applied I²C timing fix · bus 100 kHz · 2 warnings resolved", tone: "success" },
      ],
      serial: [
        ...s.serial,
        { id: uid("s"), time: simTime(s.elapsed + 1), level: "success" as const, text: "I²C bus clocked at 100 kHz · clock-stretch warnings cleared" },
      ].slice(-90),
    }));
    get().addToast({ title: "I²C timing fixed", detail: "2 warnings resolved · bus set to 100 kHz", tone: "success" });
  },
  addToast: (toast) => {
    const id = uid("toast");
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }].slice(-3) }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  switchProject: (id) => {
    const s = get();
    if (id === s.activeProjectId) return;
    const snapshot: WorkspaceSnapshot = { components: s.components, wires: s.wires, files: s.files };
    const existing = s.workspaces[id];
    const target = existing ?? baseWorkspace();
    const project = s.projects.find((p) => p.id === id);
    set({
      workspaces: { ...s.workspaces, [s.activeProjectId]: snapshot, [id]: target },
      activeProjectId: id,
      components: clone(target.components),
      wires: clone(target.wires),
      files: { ...target.files },
      activeTab: "circuit",
      activeNav: "circuit",
      openTabs: ["circuit", "main.py", "sensors.py", "serial"],
      selectedId: null,
      dirty: false,
      dialog: null,
      elapsed: 0,
      runState: "running",
    });
    get().addToast({ title: "Opened " + (project?.name ?? "project"), detail: project?.board ?? "Workspace restored", tone: "default" });
  },

  createProject: (input) => {
    const s = get();
    const id = uid("project");
    const meta: ProjectMeta = {
      id,
      name: input.name || "Untitled Project",
      description: "A new hardware workspace created in Aether Studio.",
      board: input.board,
      updated: "Just now",
      accent: "#007AFF",
      template: input.template,
    };
    const snapshot: WorkspaceSnapshot = { components: s.components, wires: s.wires, files: s.files };
    const workspace = baseWorkspace();
    if (input.template === "Blank workspace") {
      workspace.components = [clone(board)];
      workspace.wires = [];
    }
    workspace.files["config.json"] = workspace.files["config.json"].replace(/Smart Environment Monitor/g, meta.name);
    set({
      projects: [...s.projects, meta],
      workspaces: { ...s.workspaces, [s.activeProjectId]: snapshot, [id]: workspace },
      activeProjectId: id,
      components: clone(workspace.components),
      wires: clone(workspace.wires),
      files: { ...workspace.files },
      activeTab: "circuit",
      activeNav: "circuit",
      openTabs: ["circuit", "main.py", "sensors.py", "serial"],
      selectedId: null,
      dirty: false,
      dialog: null,
      elapsed: 0,
      runState: "running",
      selectedPin: null,
      libraryOpen: false,
    });
    get().addToast({ title: "Project created", detail: meta.name + " · " + meta.board, tone: "success" });
  },

  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
}));
