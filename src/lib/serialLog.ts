// Native serial session log: pure text bookkeeping with no DOM, IPC or hardware access.
// The transport store feeds decoded UTF-8 text; the UI renders the snapshot and exports it.
// Only the native serial transport is recorded; Demo Simulation and WebSocket sessions never enter the log.

export type SerialLogKind = "rx" | "tx" | "lifecycle" | "error";
export type SerialLogStatus = "connecting" | "connected" | "disconnected" | "error";

export interface SerialLogEntry { seq: number; at: string; kind: SerialLogKind; text: string }
export interface SerialLogInfo { transportId: string; address: string; baudRate: string }

export interface SerialLogSnapshot {
  token: number;
  info: SerialLogInfo;
  startedAt: string;
  endedAt: string | null;
  status: SerialLogStatus;
  error: string;
  rxBytes: number;
  txBytes: number;
  entries: SerialLogEntry[];
  droppedEntries: number;
  droppedBytes: number;
  truncatedEntries: number;
  truncatedBytes: number;
  backendOverflow: boolean;
}

export const SERIAL_LOG_LIMITS = { maxEntries: 4000, maxBytes: 256 * 1024, maxEntryBytes: 16 * 1024 } as const;
const TRUNCATION_MARK = "…（已截断）";

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).length;
export const isNativeSerialTransport = (id: string) => id === "native-serial";

const now = () => new Date().toISOString();

/** Shorten by code points so a multibyte character or surrogate pair is never split. */
export function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= limit) return { text, truncated: false };
  const markBytes = utf8Bytes(TRUNCATION_MARK);
  const budget = Math.max(0, limit - markBytes);
  const points = Array.from(text);
  let low = 0; let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(points.slice(0, middle).join("")) <= budget) low = middle; else high = middle - 1;
  }
  return { text: points.slice(0, low).join("") + TRUNCATION_MARK, truncated: true };
}

interface InternalSession extends SerialLogSnapshot {
  bytes: number;
}

const emptySession = (token: number, info: SerialLogInfo, at: string): InternalSession => ({
  token,
  info: { transportId: info.transportId, address: info.address, baudRate: info.baudRate },
  startedAt: at, endedAt: null, status: "connecting", error: "",
  rxBytes: 0, txBytes: 0, entries: [], bytes: 0,
  droppedEntries: 0, droppedBytes: 0, truncatedEntries: 0, truncatedBytes: 0, backendOverflow: false,
});

/**
 * One native session is current. A connect attempt is a candidate that only replaces the current
 * session after the port actually opens; an aborted attempt leaves the retained log untouched.
 * Tokens make late callbacks from a replaced or ended session inert.
 */
export class SerialSessionLog {
  private nextToken = 0;
  private nextSeq = 0;
  private current: InternalSession | null = null;
  private candidate: InternalSession | null = null;

  prepare(info: SerialLogInfo): number {
    if (!isNativeSerialTransport(info.transportId)) return -1;
    const token = ++this.nextToken;
    this.candidate = emptySession(token, info, now());
    return token;
  }

  commit(token: number): boolean {
    const candidate = this.candidate;
    if (!candidate || candidate.token !== token) return false;
    candidate.status = "connected";
    this.current = candidate;
    this.candidate = null;
    return true;
  }

  abort(token: number): boolean {
    if (this.candidate?.token !== token) return false;
    this.candidate = null;
    return true;
  }

  private target(token: number): InternalSession | null {
    if (this.candidate?.token === token) return this.candidate;
    if (this.current?.token === token && this.current.status === "connected") return this.current;
    return null;
  }

  append(token: number, kind: SerialLogKind, text: string, at = now()): boolean {
    const session = this.target(token);
    if (!session || typeof text !== "string" || text.length === 0) return false;
    const originalBytes = utf8Bytes(text);
    const bounded = truncateUtf8(text, SERIAL_LOG_LIMITS.maxEntryBytes);
    const bytes = utf8Bytes(bounded.text);
    session.entries.push({ seq: ++this.nextSeq, at, kind, text: bounded.text });
    session.bytes += bytes;
    // Report the bytes actually removed by truncation, not the retained size.
    if (bounded.truncated) { session.truncatedEntries++; session.truncatedBytes += originalBytes - bytes; }
    while (session.entries.length > SERIAL_LOG_LIMITS.maxEntries || session.bytes > SERIAL_LOG_LIMITS.maxBytes) {
      const dropped = session.entries.shift();
      if (!dropped) break;
      const droppedSize = utf8Bytes(dropped.text);
      session.bytes -= droppedSize;
      session.droppedEntries++;
      session.droppedBytes += droppedSize;
    }
    return true;
  }

  addRx(token: number, text: string, bytes: number): boolean {
    const session = this.target(token);
    if (!session) return false;
    // A chunk can decode to "" when a multibyte character is split across polls; its bytes still arrived.
    session.rxBytes += Math.max(0, Math.trunc(bytes));
    if (text) this.append(token, "rx", text);
    return true;
  }

  addTx(token: number, text: string, bytes: number): boolean {
    const session = this.target(token);
    if (!session) return false;
    session.txBytes += Math.max(0, Math.trunc(bytes));
    if (text) this.append(token, "tx", text);
    return true;
  }

  addLifecycle(token: number, text: string): boolean {
    return this.append(token, "lifecycle", text);
  }

  /** Record a non-fatal error marker without ending the session (e.g. a close that must be retried). */
  addError(token: number, text: string): boolean {
    return this.append(token, "error", text);
  }

  /** Record a connection error and settle the session as failed. */
  fail(token: number, text: string): boolean {
    const session = this.target(token);
    if (!session) return false;
    if (/接收缓存已满/.test(text)) session.backendOverflow = true;
    this.append(token, "error", text);
    return this.ended(token, "error", text);
  }

  ended(token: number, status: Exclude<SerialLogStatus, "connecting" | "connected">, error = ""): boolean {
    if (this.candidate?.token === token) { this.candidate = null; return true; }
    const session = this.current;
    if (!session || session.token !== token || session.status !== "connected") return false;
    session.status = status;
    session.endedAt = now();
    if (error) session.error = error;
    return true;
  }

  discard(): boolean {
    const had = !!this.current || !!this.candidate;
    this.current = null;
    this.candidate = null;
    return had;
  }

  /** True when this token belongs to the committed (retained) session, not a pending attempt. */
  owns(token: number): boolean { return this.current?.token === token; }

  activeToken(): number {
    if (this.current?.status === "connected") return this.current.token;
    if (this.candidate) return this.candidate.token;
    return -1;
  }

  snapshot(): SerialLogSnapshot | null {
    const session = this.current;
    if (!session) return null;
    return {
      token: session.token,
      info: { ...session.info },
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      status: session.status,
      error: session.error,
      rxBytes: session.rxBytes,
      txBytes: session.txBytes,
      entries: session.entries.map((entry) => ({ ...entry })),
      droppedEntries: session.droppedEntries,
      droppedBytes: session.droppedBytes,
      truncatedEntries: session.truncatedEntries,
      truncatedBytes: session.truncatedBytes,
      backendOverflow: session.backendOverflow,
    };
  }
}

const MARKER: Record<SerialLogKind, string> = { rx: "RX", tx: "TX", lifecycle: "--", error: "!!" };
const STATUS_LABEL: Record<SerialLogStatus, string> = { connecting: "连接中", connected: "已连接", disconnected: "已断开", error: "错误" };

/** Deterministic text format for the diagnostic file; callers pass exportedAt in tests. */
export function formatSerialLog(snapshot: SerialLogSnapshot, options: { exportedAt?: string } = {}): string {
  const lines = [
    "Aether Studio 串口诊断日志",
    "导出时间：" + (options.exportedAt ?? now()),
    "传输插件：" + snapshot.info.transportId,
    "端口：" + (snapshot.info.address || "未知"),
    "波特率：" + (snapshot.info.baudRate || "未知"),
    "会话开始：" + snapshot.startedAt,
    "会话结束：" + (snapshot.endedAt ?? "进行中"),
    "状态：" + STATUS_LABEL[snapshot.status],
    "接收：" + snapshot.rxBytes + " 字节",
    "发送：" + snapshot.txBytes + " 字节（只统计写入成功的 TX）",
    "日志上限：" + SERIAL_LOG_LIMITS.maxEntries + " 条 / " + SERIAL_LOG_LIMITS.maxBytes + " UTF-8 字节",
    "已丢弃较早记录：" + (snapshot.droppedEntries ? snapshot.droppedEntries + " 条 / " + snapshot.droppedBytes + " 字节" : "无"),
  ];
  if (snapshot.truncatedEntries) lines.push("超长记录截断：" + snapshot.truncatedEntries + " 条 / " + snapshot.truncatedBytes + " 字节");
  lines.push("后端接收缓存溢出：" + (snapshot.backendOverflow ? "是（连接已停止）" : "否"));
  if (snapshot.error) lines.push("错误：" + snapshot.error);
  lines.push("说明：本文件只包含本机串口会话记录，不包含固件、凭证或设备 MAC；端口名与时序可能仍含设备标识。");
  lines.push("---");
  if (snapshot.droppedEntries) lines.push("!! 已丢弃较早记录 " + snapshot.droppedEntries + " 条 / " + snapshot.droppedBytes + " 字节");
  if (!snapshot.entries.length) lines.push("（无记录）");
  for (const entry of snapshot.entries) lines.push("[" + entry.at + "] " + MARKER[entry.kind] + " " + entry.text);
  return lines.join("\n") + "\n";
}
