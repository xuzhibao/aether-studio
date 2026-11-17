import type { DesktopAPI } from "../../shared/desktop";
declare global { interface Window { aether?: DesktopAPI } }
export const isDesktop = () => typeof window !== "undefined" && window.aether?.runtime === "electron";
export async function windowAction(action: "close" | "minimize" | "maximize"): Promise<boolean> {
  if (!isDesktop()) return false;
  await window.aether!.window(action); return true;
}
