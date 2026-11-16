import type { DockTab } from "../types";
export interface WorkspacePreferences {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  agentCollapsed: boolean;
  agentWidth: number;
  dockOpen: boolean;
  dockHeight: number;
  dockTab: DockTab;
  splitMode: boolean;
  splitRatio: number;
  settings: { reducedMotion: boolean; autopilot: boolean; fontSize: number };
}
export const defaultLayout: WorkspacePreferences = {
  sidebarCollapsed: false, sidebarWidth: 238, agentCollapsed: false, agentWidth: 366,
  dockOpen: true, dockHeight: 218, dockTab: "code", splitMode: false, splitRatio: 58,
  settings: { reducedMotion: false, autopilot: false, fontSize: 12.5 },
};
const key = "aether.layout.v1";
export function readLayout(): { layout: WorkspacePreferences; error: string } {
  const layout = structuredClone(defaultLayout);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { layout, error: "" };
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !saved.layout) throw new Error("不支持的布局格式");
    const next = saved.layout;
    for (const field of ["sidebarCollapsed", "agentCollapsed", "dockOpen", "splitMode"]) if (typeof next[field] !== "boolean") throw new Error("布局开关数据无效");
    for (const [field, min, max] of [["sidebarWidth", 208, 304], ["agentWidth", 316, 470], ["dockHeight", 128, 360], ["splitRatio", 36, 72]] as const) if (typeof next[field] !== "number" || next[field] < min || next[field] > max) throw new Error("布局尺寸无效");
    if (!["code", "serial", "console", "variables", "logic", "performance"].includes(next.dockTab) || typeof next.settings?.reducedMotion !== "boolean" || typeof next.settings.fontSize !== "number" || next.settings.fontSize < 10 || next.settings.fontSize > 22) throw new Error("布局设置无效");
    return { layout: {
      sidebarCollapsed: next.sidebarCollapsed, sidebarWidth: next.sidebarWidth, agentCollapsed: next.agentCollapsed, agentWidth: next.agentWidth,
      dockOpen: next.dockOpen, dockHeight: next.dockHeight, dockTab: next.dockTab, splitMode: next.splitMode, splitRatio: next.splitRatio,
      settings: { reducedMotion: next.settings.reducedMotion, autopilot: false, fontSize: next.settings.fontSize },
    }, error: "" };
  } catch (error) { return { layout, error: `读取布局失败：${String(error)}` }; }
}
export function writeLayout(state: WorkspacePreferences) {
  const { sidebarCollapsed, sidebarWidth, agentCollapsed, agentWidth, dockOpen, dockHeight, dockTab, splitMode, splitRatio, settings } = state;
  localStorage.setItem(key, JSON.stringify({ version: 1, layout: { sidebarCollapsed, sidebarWidth, agentCollapsed, agentWidth, dockOpen, dockHeight, dockTab, splitMode, splitRatio, settings } }));
}
