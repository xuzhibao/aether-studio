import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTerminal } from "../store/terminal";
import type { TerminalSnapshot } from "../../shared/terminal";
export function createTerminalClient() {
  const api = window.aether!.terminal;
  const term = new Terminal({ cursorBlink: true, fontSize: 12, lineHeight: 1.25, fontFamily: '"JetBrains Mono Variable", monospace', scrollback: 3000, screenReaderMode: true, theme: { background: "#FFFFFF", foreground: "#343940", cursor: "#007AFF", selectionBackground: "#D9E9FF" } });
  const fit = new FitAddon(); term.loadAddon(fit);
  const host = document.createElement("div"); host.className = "h-full w-full";
  let opened = false;
  let active = true; let state: TerminalSnapshot | null = null; let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<Promise<TerminalSnapshot>>();
  const report = (error: unknown) => { if (active) useTerminal.setState({ error: String(error) }); };
  const schedule = () => { if (active && !reading && !timer) timer = setTimeout(() => { timer = undefined; void read(); }, 30); };
  const read = async () => {
    if (!active || !state || reading) return;
    const id = state.id; reading = true;
    try {
      const chunk = await api.read(id);
      if (!active || state?.id !== id) { reading = false; schedule(); return; }
      if (chunk) term.write(chunk, () => { reading = false; schedule(); });
      else { reading = false; if (state.status === "running") schedule(); }
    } catch (error) { reading = false; if (state?.id === id) report(error); else schedule(); }
  };
  const apply = (snapshot: TerminalSnapshot) => {
    if (!active || (state && snapshot.id < state.id)) return;
    state = snapshot; useTerminal.setState({ snapshot }); schedule();
  };
  const offState = api.onChanged(apply);
  void api.get().then((snapshot) => { if (snapshot) apply(snapshot); }).catch(report);
  const input = term.onData((data) => { if (state?.status === "running") void api.write(state.id, data).catch(report); });
  const resize = term.onResize(({ cols, rows }) => { if (state?.status === "running" && (state.cols !== cols || state.rows !== rows)) void api.resize(state.id, cols, rows).catch(report); });
  const fitView = () => { if (active && opened && host.isConnected && host.clientWidth > 0 && host.clientHeight > 0) fit.fit(); };
  return {
    mount(element: HTMLElement) {
      element.appendChild(host);
      if (!opened) { term.open(host); term.textarea!.setAttribute("aria-label", "Terminal input"); opened = true; }
      const observer = new ResizeObserver(fitView); observer.observe(element);
      const frame = requestAnimationFrame(() => { if (active) { fitView(); term.focus(); } });
      return () => { cancelAnimationFrame(frame); observer.disconnect(); host.remove(); };
    },
    async start(root: string) {
      useTerminal.setState({ error: "" }); term.reset(); fitView();
      const starting = api.start("system-shell", root, term.cols, term.rows); pending.add(starting);
      try { const snapshot = await starting; if (!active) { await api.stop(snapshot.id); return; } apply(snapshot); term.focus(); }
      finally { pending.delete(starting); }
    },
    async stop() { await Promise.allSettled(pending); if (state) await api.stop(state.id); },
    async interrupt() { if (state?.status === "running") await api.write(state.id, "\x03"); },
    clear() { term.clear(); term.focus(); },
    dispose() {
      active = false; clearTimeout(timer); offState(); input.dispose(); resize.dispose(); term.dispose(); host.remove();
      if (state) void api.stop(state.id).catch(() => {});
      useTerminal.setState({ snapshot: null, error: "" });
    },
  };
}
