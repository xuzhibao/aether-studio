import type { StudioPlugin, TransportConnection } from "../api";

export function createWebSocketPlugin(createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)): StudioPlugin {
  let enabled = false;
  let active: TransportConnection | undefined;
  return {
    manifest: { id: "aether.transport.websocket", name: "WebSocket 通信", version: "0.1.0", type: "transport", entry: "builtin/websocket.ts", enabled: true, description: "浏览器和桌面端的 WebSocket 字节通信。接收文本及二进制帧，发送携带 UTF-8 文本的二进制帧；不解释硬件协议或运行固件。" },
    activate(api) {
      enabled = true;
      api.register("transports", {
        id: "websocket", name: "WebSocket", endpoint: { label: "WebSocket URL", placeholder: "ws://127.0.0.1:8765 / wss://example.com/device" }, parameters: [],
        description: "连接 ws:// 或 wss:// 服务。接收文本和二进制帧；发送二进制帧，不附加硬件协议。连接地址只用于当前会话。",
        sendHint: "TX 表示字节已交给 WebSocket 发送队列，不代表网络送达或设备执行。",
        connect: ({ address }, handlers, signal) => new Promise((resolve, reject) => {
          if (!enabled) throw new Error("WebSocket 插件已停用");
          if (active) throw new Error("WebSocket 正在使用或关闭中");
          const url = new URL(address);
          if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("连接地址必须使用 ws:// 或 wss://");
          const socket = createSocket(url.href);
          socket.binaryType = "arraybuffer";
          let opened = false;
          let closing = false;
          let finishClose!: () => void;
          const closed = new Promise<void>((done) => { finishClose = done; });
          const connection: TransportConnection = {
            label: url.href,
            write: async (bytes) => {
              if (closing || socket.readyState !== 1) throw new Error("WebSocket 未连接");
              socket.send(bytes);
            },
            close: () => {
              if (!closing) {
                closing = true;
                socket.close(1000);
              }
              return closed;
            },
          };
          active = connection;
          const abort = () => { void connection.close(); };
          socket.onopen = () => {
            if (closing || !enabled || signal?.aborted) { void connection.close(); return; }
            opened = true; resolve(connection);
          };
          socket.onmessage = (event) => {
            if (closing) return;
            handlers.data(typeof event.data === "string" ? new TextEncoder().encode(event.data) : new Uint8Array(event.data));
          };
          // The close event supplies the actual close code, including failed handshakes.
          socket.onclose = (event) => {
            signal?.removeEventListener("abort", abort);
            if (active === connection) active = undefined;
            finishClose();
            if (closing) { if (!opened) reject(new Error("WebSocket 连接已取消")); return; }
            const message = `WebSocket 已关闭：${event.code}${event.reason ? " · " + event.reason : ""}`;
            if (!opened) reject(new Error(message));
            else if (event.code === 1000) handlers.closed();
            else handlers.error(message);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
      });
    },
    deactivate() { enabled = false; void active?.close(); },
  };
}
export const websocketPlugin = createWebSocketPlugin();
