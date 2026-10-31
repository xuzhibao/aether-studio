export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function windowAction(action: "close" | "minimize" | "maximize"): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (action === "close") await win.close();
    if (action === "minimize") await win.minimize();
    if (action === "maximize") await win.toggleMaximize();
    return true;
  } catch {
    return false;
  }
}
