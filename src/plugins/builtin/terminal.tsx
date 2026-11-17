import { lazy, Suspense } from "react";
import { isDesktop } from "../../lib/desktop";
import { useTerminal } from "../../store/terminal";
import type { StudioPlugin } from "../api";
const LazyPanel = lazy(() => import("./TerminalPanel"));
function TerminalPanel() { return <Suspense fallback={<div className="p-5 text-xs">Loading terminal…</div>}><LazyPanel /></Suspense>; }
export const terminalPlugin: StudioPlugin = (() => {
  let active = false;
  let client: Promise<ReturnType<typeof import("../../terminal/client").createTerminalClient>> | undefined;
  const load = () => { if (!isDesktop()) throw new Error("终端需要 Electron 桌面端"); return client ??= import("../../terminal/client").then((module) => module.createTerminalClient()); };
  const report = (error: unknown) => { if (active) useTerminal.setState({ error: String(error) }); };
  return {
    manifest: { id: "aether.terminal.shell", name: "交互式终端", version: "0.1.0", type: "terminal", entry: "builtin/terminal.tsx", enabled: true, description: "在磁盘工程目录启动本机 shell，使用真实 PTY 和 xterm.js。支持输入、Ctrl+C、中断、调整尺寸和会话清理；不会自动执行 Agent 请求。" },
    activate(api) {
      active = true; client = undefined;
      api.register("terminals", { id: "system-shell", name: "System shell", start: async (root) => { await (await load()).start(root); }, stop: async () => { await (await load()).stop(); }, interrupt: async () => { await (await load()).interrupt(); }, clear: async () => { (await load()).clear(); }, mount: (element) => {
        let mounted = true; let dispose: (() => void) | undefined;
        void load().then((value) => { if (mounted && active) dispose = value.mount(element); }).catch(report);
        return () => { mounted = false; dispose?.(); };
      } });
      api.register("panels", { id: "terminal.shell", name: "Terminal", render: TerminalPanel });
      api.register("commands", { id: "terminal.open", name: "Open project terminal", run: async () => { const { useStudio } = await import("../../store/studio"); useStudio.getState().openFile("panel:terminal.shell"); } });
    },
    deactivate() { active = false; const old = client; client = undefined; void old?.then((value) => value.dispose()); },
  };
})();
