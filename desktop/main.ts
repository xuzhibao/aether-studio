import { app, BrowserWindow, dialog, ipcMain, protocol, net } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, promises as fs } from "node:fs";
import { WorkspaceService } from "./workspace";
import { TaskService } from "./tasks";
import { platformioBuild, platformioUpload, platformioCompileDatabase } from "./plugins/platformio";
import { LanguageService } from "./language";
import { clangdProvider } from "./plugins/clangd";
import { SerialService } from "./plugins/serial";
import type { ProjectContext } from "../src/plugins/api";

protocol.registerSchemesAsPrivileged([{ scheme: "aether", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.AETHER_USER_DATA_DIR) { mkdirSync(process.env.AETHER_USER_DATA_DIR, { recursive: true }); app.setPath("userData", path.resolve(process.env.AETHER_USER_DATA_DIR)); }
let window: BrowserWindow;
let dirty = false;
const confirmClose = (detail = "选择放弃修改将关闭窗口。") => {
  if (!dirty) return true;
  const discard = dialog.showMessageBoxSync(window, { type: "question", message: "工程有未保存修改", detail, buttons: ["取消", "放弃修改并继续"], defaultId: 0, cancelId: 0 }) === 1;
  return discard;
};
let operations: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => { const result = operations.then(fn); operations = result.catch(() => {}); return result; };
const emit = (channel: string, value: unknown) => { if (window && !window.isDestroyed()) window.webContents.send(channel, value); };
const workspace = new WorkspaceService((root) => emit("workspace:changed", root));
const tasks = new TaskService(workspace, (task) => emit("tasks:changed", task));
tasks.register(platformioBuild); tasks.register(platformioUpload); tasks.register(platformioCompileDatabase);
const serial = new SerialService();
const language = new LanguageService(workspace, (snapshot) => emit("language:changed", snapshot));
language.register(clangdProvider);
const stateFile = () => path.join(app.getPath("userData"), "workspace.json");
const remember = async () => { await fs.mkdir(app.getPath("userData"), { recursive: true }); await fs.writeFile(stateFile(), JSON.stringify({ root: workspace.root })); };
const chooseFolder = async () => { const result = await dialog.showOpenDialog(window, { title: "Open Aether Project Folder", properties: ["openDirectory", "createDirectory"] }); return result.canceled ? null : result.filePaths[0]; };
const beforeSwitch = async () => { await tasks.stopAll(); await serial.dispose(); await language.stop(); };
function routes() {
  const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("不接受此窗口的请求");
    return fn(...args);
  });
  handle("window:action", (action: string) => { if (action === "close") window.close(); else if (action === "minimize") window.minimize(); else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize(); });
  handle("files:export", async (name: string, content: string) => {
    const result = await dialog.showSaveDialog(window, { title: "Export Aether Project", defaultPath: path.basename(name), filters: [{ name: "Aether Project", extensions: ["aether"] }] });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, content); return result.filePath;
  });
  handle("files:import", async () => { const result = await dialog.showOpenDialog(window, { title: "Open Aether Project", properties: ["openFile"], filters: [{ name: "Aether Project", extensions: ["aether", "json"] }] }); return result.canceled ? null : fs.readFile(result.filePaths[0], "utf8"); });
  handle("workspace:setDirty", (value: boolean) => { dirty = value === true; });
  handle("workspace:open", () => enqueue(async () => { const folder = await chooseFolder(); if (!folder || !confirmClose("打开另一个目录将放弃当前未保存修改。")) return null; await beforeSwitch(); const result = await workspace.open(folder); await remember(); return result; }));
  handle("workspace:saveAs", (context: ProjectContext) => enqueue(async () => { const folder = await chooseFolder(); if (!folder) return null; await beforeSwitch(); const result = await workspace.saveAs(folder, context); await remember(); return result; }));
  handle("workspace:save", (context: ProjectContext) => enqueue(async () => { if (tasks.list().some((task) => task.status === "running")) throw new Error("构建运行中，请等待或取消任务后保存"); await workspace.save(context); }));
  handle("workspace:reload", () => enqueue(async () => { await beforeSwitch(); return workspace.reload(); }));
  handle("workspace:close", () => enqueue(async () => { await beforeSwitch(); await workspace.close(); await remember(); }));
  handle("workspace:restore", () => enqueue(async () => {
    const content = await fs.readFile(stateFile(), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!content) return null;
    const saved = JSON.parse(content); return saved.root ? workspace.open(saved.root) : null;
  }));
  handle("language:start", (provider, root) => enqueue(() => language.start(provider, root)));
  handle("language:stop", (id) => enqueue(() => language.stop(id)));
  handle("language:get", () => language.get());
  handle("language:open", (id, file, text, version) => enqueue(() => language.open(id, file, text, version)));
  handle("language:change", (id, file, text, version) => enqueue(() => language.change(id, file, text, version)));
  handle("language:close", (id, file) => enqueue(() => language.close(id, file)));
  handle("language:request", (id, file, version, method, position) => language.request(id, file, version, method, position));
  handle("tasks:start", (provider: string, options: Record<string, string> = {}) => enqueue(() => tasks.start(provider, options)));
  handle("tasks:cancel", (id: string) => tasks.cancel(id));
  handle("tasks:list", () => tasks.list());
  handle("serial:list", () => serial.list()); handle("serial:open", (port: string, baud: number) => serial.open(port, baud));
  handle("serial:read", (id: number) => serial.read(id)); handle("serial:write", (id: number, bytes: number[]) => serial.write(id, bytes)); handle("serial:close", (id: number) => serial.close(id));
}
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault(); if (!confirmClose()) return; dirty = false; quitting = true;
  void Promise.all([tasks.stopAll(), serial.dispose(), language.stop(), workspace.close()]).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
// Keep the ESM entry import complete so Electron can reach its ready event.
void app.whenReady().then(async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const assets = path.resolve(directory, "../dist");
  protocol.handle("aether", (request) => {
    const url = new URL(request.url);
    const file = path.resolve(assets, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (url.hostname !== "app" || !file.startsWith(assets + path.sep)) return new Response("Forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).href);
  });
  window = new BrowserWindow({ width: 1728, height: 1080, minWidth: 1180, minHeight: 760, frame: false, backgroundColor: "#F5F6F8", webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.on("close", (event) => { if (!confirmClose()) event.preventDefault(); else dirty = false; });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  routes();
  if (process.env.AETHER_DEV_URL) {
    const url = new URL(process.env.AETHER_DEV_URL);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("开发服务器只能使用本机 HTTP 地址");
    await window.loadURL(url.href);
  } else await window.loadURL("aether://app/index.html");
}).catch((error) => { console.error("Aether startup failed", error); app.exit(1); });
