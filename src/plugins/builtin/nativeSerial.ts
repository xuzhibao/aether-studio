import { isDesktop } from "../../lib/desktop";
import type { StudioPlugin, TransportConnection, TransportPort } from "../api";

export interface SerialBackend {
  list: () => Promise<TransportPort[]>;
  open: (path: string, baudRate: number) => Promise<number>;
  read: (id: number) => Promise<number[]>;
  write: (id: number, data: number[]) => Promise<void>;
  close: (id: number) => Promise<void>;
}
const desktopBackend: SerialBackend = {
  list: () => window.aether!.serial.list(), open: (path, baudRate) => window.aether!.serial.open(path, baudRate),
  read: (id) => window.aether!.serial.read(id), write: (id, data) => window.aether!.serial.write(id, data), close: (id) => window.aether!.serial.close(id),
};
export function createNativeSerialPlugin(backend = desktopBackend, supported = isDesktop()): StudioPlugin {
  let enabled = false;
  let active: TransportConnection | undefined;
  return {
    manifest: { id: "aether.serial.native", name: "桌面串口", version: "0.1.0", type: "transport", entry: "builtin/nativeSerial.ts", enabled: true, description: "通过 Electron 原生串口插件枚举和打开端口，收发原始字节。8N1、无流控；需手动连接，不自动烧录或执行固件。浏览器中不可用。" },
    activate(api) {
      enabled = true;
      api.register("transports", {
        id: "native-serial", name: "Native Serial", unavailable: supported ? undefined : "请在 Electron 桌面端使用原生串口；浏览器不提供此能力。",
        endpoint: { label: "端口路径", placeholder: "COM3 / /dev/ttyUSB0 / /dev/cu.usbserial…" },
        parameters: [{ key: "baudRate", label: "波特率", type: "number", initial: "115200", min: 1 }],
        description: "8 data bits · no parity · 1 stop bit · no flow control。也可手动填写未枚举到的端口路径。打开端口不识别开发板或固件。",
        sendHint: "TX 在串口写入成功后记录，不代表设备已执行命令。",
        list: async () => { if (!supported) throw new Error("原生串口仅支持桌面端"); return backend.list(); },
        connect: async ({ address, parameters }, handlers, signal) => {
          const path = address;
          const baudRate = Number(parameters.baudRate);
          if (!Number.isInteger(baudRate) || baudRate <= 0) throw new Error("请输入有效的波特率");
          if (!enabled || !supported) throw new Error("桌面串口插件不可用");
          if (active) throw new Error("串口正在使用或关闭中，请稍后重试");
          let closed = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let closing: Promise<void> | undefined;
          const opened = backend.open(path, baudRate);
          const connection: TransportConnection = {
            label: path + " · " + baudRate + " baud",
            write: async (bytes) => { if (closed) throw new Error("串口连接已关闭"); await backend.write(await opened, Array.from(bytes)); },
            close: () => {
              if (closing) return closing;
              closed = true; clearTimeout(timer);
              // Keep the active handle when the backend close fails, so a later disconnect can retry the same session.
              closing = opened.then((id) => backend.close(id), () => {}).then(
                () => { signal?.removeEventListener("abort", abort); if (active === connection) active = undefined; },
                (error) => { closing = undefined; throw error; },
              );
              return closing;
            },
          };
          const abort = () => { void connection.close().catch((error) => api.host.log("关闭串口失败：" + String(error))); };
          active = connection;
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
          let id: number;
          try { id = await opened; }
          catch (error) { if (active === connection) active = undefined; throw error; }
          if (closed || !enabled) { await connection.close(); throw new Error("串口连接已取消"); }
          const poll = async () => {
            try {
              const bytes = await backend.read(id);
              if (closed) return;
              if (bytes.length) handlers.data(Uint8Array.from(bytes));
              timer = setTimeout(poll, 100);
            } catch (error) {
              if (closed) return;
              await connection.close().catch((closeError) => api.host.log("关闭串口失败：" + String(closeError)));
              handlers.error(String(error));
            }
          };
          timer = setTimeout(poll, 100);
          return connection;
        },
      });
    },
    deactivate() {
      enabled = false;
      // Stop polling immediately; close the native session when a pending open completes.
      void active?.close().catch((error) => console.error("关闭串口失败", error));
    },
  };
}
export const nativeSerialPlugin = createNativeSerialPlugin();
