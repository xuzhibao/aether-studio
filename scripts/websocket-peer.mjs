// A real local WebSocket server used only by smoke tests; no simulated hardware.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";

export async function startWebSocketPeer(port = 0, outputDirectory) {
  const server = createServer();
  const peer = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  const received = [];
  const closes = [];
  let pending = 0;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/pending") { pending++; return; } // Hold handshake to test user cancellation.
    peer.handleUpgrade(request, socket, head, (client) => peer.emit("connection", client));
  });
  peer.on("connection", (socket) => {
    socket.send("WebSocket fixture: ready");
    socket.on("message", (data, binary) => {
      const text = data.toString();
      received.push({ text, binary });
      if (outputDirectory) writeFileSync(outputDirectory + "/websocket-received.json", JSON.stringify(received));
      if (text.trim() === "close-normal") socket.close(1000, "fixture done");
      else if (text.trim() === "close-error") socket.close(1011, "fixture fault");
      else {
        socket.send("WebSocket fixture text: " + text);
        socket.send(Buffer.from("WebSocket fixture binary: " + text));
      }
    });
    socket.on("close", (code) => {
      closes.push(code);
      if (outputDirectory) writeFileSync(outputDirectory + "/websocket-closes.json", JSON.stringify(closes));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `ws://127.0.0.1:${server.address().port}`;
  return {
    url, received, closes, get pending() { return pending; },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise((resolve) => peer.close(resolve)), new Promise((resolve) => server.close(resolve))]); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const peer = await startWebSocketPeer(1422, "smoke-results");
  writeFileSync("smoke-results/websocket-url.txt", peer.url);
  console.log("WebSocket smoke peer listening: " + peer.url);
}
