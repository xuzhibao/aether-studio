import { create } from "zustand";
import { plugins } from "../plugins/runtime";
import type { TransportConnection, TransportOptions } from "../plugins/api";
import type { SerialLine } from "../types";
import { uid } from "../lib/utils";

type Status = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
interface TransportState {
  status: Status;
  transportId: string;
  address: string;
  label: string;
  sendHint: string;
  error: string;
  lines: SerialLine[];
  receivedBytes: number;
  sentBytes: number;
  connect: (id: string, options: TransportOptions) => Promise<void>;
  disconnect: () => Promise<void>;
  send: (text: string) => Promise<void>;
  clear: () => void;
}
let connection: TransportConnection | undefined;
let generation = 0;
let pendingController: AbortController | undefined;
const line = (text: string, level: SerialLine["level"] = "info"): SerialLine => ({ id: uid("io"), time: new Date().toLocaleTimeString("en-GB", { hour12: false }), text, level });
export const useTransport = create<TransportState>((set, get) => ({
  status: "disconnected", transportId: "", address: "", label: "", sendHint: "", error: "", lines: [], receivedBytes: 0, sentBytes: 0,
  connect: async (id, options) => {
    if (["connecting", "connected", "disconnecting"].includes(get().status)) return;
    const attempt = ++generation;
    const controller = new AbortController();
    pendingController = controller;
    const decoder = new TextDecoder();
    set({ status: "connecting", transportId: id, address: options.address, label: options.address, error: "", receivedBytes: 0, sentBytes: 0 });
    try {
      if (!options.address.trim()) throw new Error("请输入连接地址");
      const transport = plugins.require("transports", id);
      if (transport.unavailable) throw new Error(transport.unavailable);
      set({ sendHint: transport.sendHint });
      const opened = await transport.connect(options, {
        data: (bytes) => {
          if (attempt !== generation) return;
          const text = decoder.decode(bytes, { stream: true });
          set((s) => ({ receivedBytes: s.receivedBytes + bytes.length, lines: text ? [...s.lines, line("RX · " + text, "data")].slice(-500) : s.lines }));
          plugins.emit("transport:received", { id, address: options.address, bytes });
        },
        closed: () => {
          if (attempt !== generation) return;
          generation++; connection = undefined;
          set((s) => ({ status: "disconnected", error: "", lines: [...s.lines, line("远端正常关闭连接")].slice(-500) }));
          plugins.emit("transport:disconnected", { id });
        },
        error: (message) => {
          if (attempt !== generation) return;
          generation++; connection = undefined;
          set((s) => ({ status: "error", error: message, lines: [...s.lines, line("连接中断：" + message, "warn")].slice(-500) }));
          plugins.emit("transport:disconnected", { id, error: message });
        },
      }, controller.signal);
      if (attempt !== generation) { await opened.close(); return; }
      connection = opened;
      set((s) => ({ status: "connected", label: opened.label, lines: [...s.lines, line("已连接 " + opened.label, "success")].slice(-500) }));
      plugins.emit("transport:connected", { id, ...options });
    } catch (error) {
      if (attempt === generation) set({ status: "error", error: String(error) });
    } finally { if (pendingController === controller) pendingController = undefined; }
  },
  disconnect: async () => {
    if (["disconnected", "disconnecting"].includes(get().status)) return;
    generation++;
    pendingController?.abort();
    pendingController = undefined;
    const closing = connection;
    connection = undefined;
    const id = get().transportId;
    set({ status: "disconnecting" });
    try {
      await closing?.close();
      set((s) => ({ status: "disconnected", error: "", lines: [...s.lines, line("连接已断开")].slice(-500) }));
      plugins.emit("transport:disconnected", { id });
    } catch (error) { set({ status: "error", error: "关闭连接失败：" + String(error) }); }
  },
  send: async (text) => {
    const current = connection;
    const attempt = generation;
    if (!current || get().status !== "connected") throw new Error("请先建立连接");
    const bytes = new TextEncoder().encode(text);
    try {
      await current.write(bytes);
      if (attempt !== generation) return;
      set((s) => ({ sentBytes: s.sentBytes + bytes.length, lines: [...s.lines, line("TX · " + text, "info")].slice(-500) }));
      plugins.emit("transport:sent", { id: get().transportId, bytes });
    } catch (error) {
      if (attempt !== generation) throw error;
      await get().disconnect();
      set({ status: "error", error: "发送失败：" + String(error) });
      throw error;
    }
  },
  clear: () => set({ lines: [] }),
}));
plugins.on("plugin:disabled", () => {
  const state = useTransport.getState();
  if (["connecting", "connected"].includes(state.status) && !plugins.get("transports", state.transportId)) void state.disconnect();
});
