import { spawn } from "node:child_process";
import electron from "electron";
import "./build-desktop.mjs";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" });
let app;
const stop = () => { app?.kill(); server.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
try {
  let ready = false;
  for (let n = 0; n < 80; n++) { try { ready = (await fetch("http://127.0.0.1:1420")).ok; } catch {} if (ready) break; await new Promise((resolve) => setTimeout(resolve, 250)); }
  if (!ready) throw new Error("Vite 未启动");
  const env = { ...process.env, AETHER_DEV_URL: "http://127.0.0.1:1420" }; delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, ["."], { stdio: "inherit", env });
  app.on("exit", (code) => { server.kill(); process.exitCode = code ?? 1; });
} catch (error) { stop(); throw error; }
