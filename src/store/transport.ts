import { create } from "zustand";
import { plugins } from "../plugins/runtime";
import type { TransportConnection, TransportOptions } from "../plugins/api";
import type { SerialLine } from "../types";
import { uid } from "../lib/utils";

type Status = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
interface TransportState {
  status: Status;
  transportId: string;
  path: string;
  baudRate: number;
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
const line = (text: string, level: SerialLine["level"] = "info"): SerialLine => ({ id: uid("io"), time: new Date().toLocaleTimeString("en-GB", { hour12: false }), text, level });
export const useTransport = create<TransportState>((set, get) => ({
  status: "disconnected", transportId: "", path: "", baudRate: 115200, error: "", lines: [], receivedBytes: 0, sentBytes: 0,
  connect: async (id, options) => {
    if (["connecting", "connected", "disconnecting"].includes(get().status)) return;
    const attempt = ++generation;
    const decoder = new TextDecoder();
    set({ status: "connecting", transportId: id, path: options.path, baudRate: options.baudRate, error: "", receivedBytes: 0, sentBytes: 0 });
    try {
      if (!options.path.trim() || !Number.isInteger(options.baudRate) || options.baudRate <= 0) throw new Error("请输入端口路径和有效的波特率");
      const transport = plugins.require("transports", id);
      if (transport.unavailable) throw new Error(transport.unavailable);
      const opened = await transport.connect(options, {
        data: (bytes) => {
          if (attempt !== generation) return;
          const text = decoder.decode(bytes, { stream: true });
          set((s) => ({ receivedBytes: s.receivedBytes + bytes.length, lines: text ? [...s.lines, line("RX · " + text, "data")].slice(-500) : s.lines }));
          plugins.emit("transport:received", { id, path: options.path, bytes });
        },
        error: (message) => {
          if (attempt !== generation) return;
          generation++; connection = undefined;
          set((s) => ({ status: "error", error: message, lines: [...s.lines, line("连接中断：" + message, "warn")].slice(-500) }));
          plugins.emit("transport:disconnected", { id, error: message });
        },
      });
      if (attempt !== generation) { await opened.close(); return; }
      connection = opened;
      set((s) => ({ status: "connected", lines: [...s.lines, line("已打开端口 " + options.path + " · " + options.baudRate + " baud；未检测固件或开发板型号。", "success")].slice(-500) }));
      plugins.emit("transport:connected", { id, ...options });
    } catch (error) {
      if (attempt === generation) set({ status: "error", error: String(error) });
    }
  },
  disconnect: async () => {
    if (["disconnected", "disconnecting"].includes(get().status)) return;
    generation++;
    const closing = connection;
    connection = undefined;
    const id = get().transportId;
    set({ status: "disconnecting" });
    try {
      await closing?.close();
      set((s) => ({ status: "disconnected", error: "", lines: [...s.lines, line("端口已断开")].slice(-500) }));
      plugins.emit("transport:disconnected", { id });
    } catch (error) { set({ status: "error", error: "关闭端口失败：" + String(error) }); }
  },
  send: async (text) => {
    const current = connection;
    const attempt = generation;
    if (!current || get().status !== "connected") throw new Error("请先连接端口");
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
