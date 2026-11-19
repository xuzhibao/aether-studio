import { useMemo } from "react";
import { create } from "zustand";
import { formatSerialLog, SerialSessionLog } from "../lib/serialLog";
import type { SerialLogInfo, SerialLogSnapshot } from "../lib/serialLog";
import { isDesktop } from "../lib/desktop";
import type { SerialLogSaveResult } from "../../shared/desktop";

// Renderer-side owner of the native serial session log. The transport store appends decoded text;
// the UI only reads snapshots, so Pause/filter/display Clear cannot alter the retained history.
const engine = new SerialSessionLog();
const revisions = create<{ revision: number }>(() => ({ revision: 0 }));
const touch = () => revisions.setState((state) => ({ revision: state.revision + 1 }));

// The retained log belongs to one project context. The first observed root only binds; later changes discard.
let trackedRoot: string | null | undefined;
let pendingExports = 0;
const invalidatePendingExport = () => {
  if (pendingExports > 0 && typeof window !== "undefined") void window.aether?.serialLog?.invalidate().catch(() => {});
};

export const serialSessionLog = {
  prepare(info: SerialLogInfo): number {
    const token = engine.prepare(info);
    if (token !== -1) touch();
    return token;
  },
  commit(token: number): boolean {
    if (!engine.commit(token)) return false;
    // A successful reconnect replaces the retained session; an open picker now targets old data.
    invalidatePendingExport();
    touch();
    return true;
  },
  abort(token: number): void { if (engine.abort(token)) touch(); },
  addRx(token: number, text: string, bytes: number): void { if (engine.addRx(token, text, bytes)) touch(); },
  addTx(token: number, text: string, bytes: number): void { if (engine.addTx(token, text, bytes)) touch(); },
  addLifecycle(token: number, text: string): void { if (engine.addLifecycle(token, text)) touch(); },
  addError(token: number, message: string): void { if (engine.addError(token, message)) touch(); },
  fail(token: number, message: string): void {
    const retained = engine.owns(token);
    if (!engine.fail(token, message)) return;
    // A failed attempt never replaced the retained session, so it must not cancel a pending export.
    if (retained) invalidatePendingExport();
    touch();
  },
  ended(token: number, status: "disconnected" | "error", error = ""): void {
    const retained = engine.owns(token);
    if (!engine.ended(token, status, error)) return;
    if (retained) invalidatePendingExport();
    touch();
  },
  activeToken: (): number => engine.activeToken(),
  snapshot: (): SerialLogSnapshot | null => engine.snapshot(),
  discard(): void { if (engine.discard()) { invalidatePendingExport(); touch(); } },
};

export function trackProjectRoot(root: string | null): void {
  if (trackedRoot === undefined) { trackedRoot = root; return; }
  if (root === trackedRoot) return;
  trackedRoot = root;
  serialSessionLog.discard();
}

/** Rebuilds the exported file name from the session, never from UI filters or display contents. */
function suggestedName(snapshot: SerialLogSnapshot): string {
  const port = (snapshot.info.address || "port").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "port";
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `aether-serial-${port}-${stamp}.txt`;
}

export async function exportSerialLog(): Promise<SerialLogSaveResult> {
  const snapshot = engine.snapshot();
  if (!snapshot) return { status: "failed", error: "没有可导出的原生串口会话记录" };
  if (!isDesktop() || !window.aether?.serialLog) return { status: "failed", error: "串口诊断导出仅支持桌面端" };
  const text = formatSerialLog(snapshot);
  pendingExports++;
  try {
    return await window.aether.serialLog.save({ suggestedName: suggestedName(snapshot), text, sessionId: String(snapshot.token) });
  } catch (error) {
    return { status: "failed", error: String(error) };
  } finally {
    pendingExports = Math.max(0, pendingExports - 1);
  }
}

export function useSerialLogSnapshot(): SerialLogSnapshot | null {
  const revision = revisions((state) => state.revision);
  return useMemo(() => engine.snapshot(), [revision]);
}

export function useSerialLogRevision(): number {
  return revisions((state) => state.revision);
}

