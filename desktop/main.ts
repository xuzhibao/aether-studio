import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, promises as fs } from "node:fs";
import { WorkspaceService } from "./workspace";
import { RecoveryService } from "./recovery";
import { TaskService } from "./tasks";
import { createPlatformioPlugins } from "./plugins/platformio";
import { LanguageService } from "./language";
import { createClangdProvider } from "./plugins/clangd";
import { TerminalService } from "./terminal";
import { shellProvider } from "./plugins/shell";
import { SerialService } from "./plugins/serial";
import { ToolService } from "./tools";
import type { ProjectContext } from "../src/plugins/api";

protocol.registerSchemesAsPrivileged([{ scheme: "aether", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.AETHER_USER_DATA_DIR) { mkdirSync(process.env.AETHER_USER_DATA_DIR, { recursive: true }); app.setPath("userData", path.resolve(process.env.AETHER_USER_DATA_DIR)); }
let window: BrowserWindow;
let dirty = false;
// Set once the user explicitly confirms discarding unsaved changes; late autosaves must not resurrect a draft.
let abandoned = false;
const confirmClose = (detail = "选择放弃修改将关闭窗口。") => {
  if (!dirty) return true;
  const discard = dialog.showMessageBoxSync(window, { type: "question", message: "工程有未保存修改", detail, buttons: ["取消", "放弃修改并继续"], defaultId: 0, cancelId: 0 }) === 1;
  return discard;
};
let operations: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => { const result = operations.then(fn); operations = result.catch(() => {}); return result; };
const emit = (channel: string, value: unknown) => { if (window && !window.isDestroyed()) window.webContents.send(channel, value); };
const workspace = new WorkspaceService((root) => emit("workspace:changed", root), (target) => shell.trashItem(target));
const recovery = new RecoveryService(() => path.join(app.getPath("userData"), "recovery"));
const tasks = new TaskService(workspace, (task) => {
  emit("tasks:changed", task);
  // Providers declare what a successful task produced; the host only reacts to the generic kind.
  if (task.status === "succeeded" && task.kind === "compile-database") {
    void enqueue(() => language.refreshCompileDatabase(task.root, task.environment ?? "")).catch((error) => console.error("clangd compile database refresh failed", error));
  }
});
const serial = new SerialService();
const terminal = new TerminalService(workspace, (state) => emit("terminal:changed", state));
terminal.register(shellProvider);
const language = new LanguageService(workspace, (snapshot) => emit("language:changed", snapshot));
// Tool paths live in the application data directory; plugins declare the tools and their UI.
const tools = new ToolService(() => path.join(app.getPath("userData"), "tools.json"), (id) => {
  void tools.list().then((list) => emit("tools:changed", list)).catch((error) => console.error("Tool settings update failed", error));
  if (id === "clangd") void language.restartForTool("clangd").catch((error) => console.error("clangd restart failed", error));
});
const platformio = createPlatformioPlugins(tools);
tasks.register(platformio.platformioBuild); tasks.register(platformio.platformioUpload); tasks.register(platformio.platformioCompileDatabase);
language.register(createClangdProvider(tools));
const stateFile = () => path.join(app.getPath("userData"), "workspace.json");
const remember = async () => { await fs.mkdir(app.getPath("userData"), { recursive: true }); await fs.writeFile(stateFile(), JSON.stringify({ root: workspace.root })); };
const chooseFolder = async () => { const result = await dialog.showOpenDialog(window, { title: "Open Aether Project Folder", properties: ["openDirectory", "createDirectory"] }); return result.canceled ? null : result.filePaths[0]; };
const beforeSwitch = async () => { await tasks.stopAll(); await serial.dispose(); await language.stop(); await terminal.stop(); };
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
  // Recovery drafts are plain files in the user data directory; they never write into the project folder.
  // After an explicit "discard changes" at quit time, ignore writes so the draft cannot reappear.
  handle("recovery:save", (draft) => abandoned ? Promise.resolve() : recovery.save(draft));
  handle("recovery:list", () => recovery.list());
  handle("recovery:read", (root: string) => recovery.read(root));
  handle("recovery:clear", (root: string, revision: number) => recovery.clear(root, revision));
  handle("recovery:discard", (root: string) => recovery.discard(root));
  handle("workspace:open", () => enqueue(async () => { const folder = await chooseFolder(); if (!folder || !confirmClose("打开另一个目录将放弃当前未保存修改。")) return null; await beforeSwitch(); const result = await workspace.open(folder); await remember(); return result; }));
  handle("workspace:saveAs", (context: ProjectContext) => enqueue(async () => { const folder = await chooseFolder(); if (!folder) return null; await beforeSwitch(); const result = await workspace.saveAs(folder, context); await remember(); return result; }));
  handle("workspace:save", (context: ProjectContext) => enqueue(async () => { if (tasks.list().some((task) => task.status === "running")) throw new Error("构建运行中，请等待或取消任务后保存"); await workspace.save(context); }));
  handle("workspace:reload", () => enqueue(async () => { await beforeSwitch(); return workspace.reload(); }));
  const fileOperation = (action: () => Promise<unknown>) => enqueue(async () => {
    if (tasks.list().some((task) => task.status === "running")) throw new Error("任务运行中，请等待或取消后再修改工程文件");
    return action();
  });
  handle("workspace:files:listing", () => enqueue(() => workspace.listing()));
  handle("workspace:files:createFile", (name: string) => fileOperation(() => workspace.createFile(name)));
  handle("workspace:files:createDirectory", (name: string) => fileOperation(() => workspace.createDirectory(name)));
  handle("workspace:files:rename", (from: string, to: string) => fileOperation(() => workspace.rename(from, to)));
  handle("workspace:files:trash", (name: string) => fileOperation(() => workspace.trash(name)));
  handle("workspace:files:write", (name: string, text: string, expected: string | null) => fileOperation(() => workspace.write(name, text, expected)));
  handle("workspace:files:accept", (name: string) => enqueue(() => workspace.accept(name)));
  handle("workspace:close", () => enqueue(async () => { await beforeSwitch(); await workspace.close(); await remember(); }));
  handle("workspace:restore", () => enqueue(async () => {
    const content = await fs.readFile(stateFile(), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!content) return null;
    const saved = JSON.parse(content); return saved.root ? workspace.open(saved.root) : null;
  }));
  handle("language:start", (provider, root, options) => enqueue(() => language.start(provider, root, options)));
  handle("language:restart", (id, options) => enqueue(() => language.restart(id, options)));
  handle("language:stop", (id) => enqueue(() => language.stop(id)));
  handle("language:get", () => language.get());
  handle("language:open", (id, file, text, version) => enqueue(() => language.open(id, file, text, version)));
  handle("language:change", (id, file, text, version) => enqueue(() => language.change(id, file, text, version)));
  handle("language:close", (id, file) => enqueue(() => language.close(id, file)));
  handle("language:request", (id, file, version, method, position) => language.request(id, file, version, method, position));
  handle("terminal:start", (provider, root, cols, rows) => enqueue(() => terminal.start(provider, root, cols, rows)));
  handle("terminal:get", () => terminal.get());
  handle("terminal:stop", (id) => enqueue(() => terminal.stop(id)));
  handle("terminal:write", (id, data) => terminal.write(id, data));
  handle("terminal:read", (id) => terminal.read(id));
  handle("terminal:resize", (id, cols, rows) => terminal.resize(id, cols, rows));
  handle("tools:list", () => tools.list());
  handle("tools:status", (id: string) => tools.status(id));
  handle("tools:setPath", (id: string, value: string) => tools.setPath(id, value));
  handle("tools:pick", async (id: string) => {
    const tool = tools.require(id);
    const result = await dialog.showOpenDialog(window, { title: "选择 " + tool.name + " 可执行文件", properties: ["openFile"], ...(process.platform === "win32" ? { filters: [{ name: "可执行文件", extensions: ["exe"] }] } : {}) });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle("tasks:start", (provider: string, options: Record<string, string> = {}) => enqueue(() => tasks.start(provider, options)));
  handle("tasks:cancel", (id: string) => tasks.cancel(id));
  handle("tasks:environments", (provider: string) => tasks.environments(provider));
  handle("tasks:list", () => tasks.list());
  handle("serial:list", () => serial.list()); handle("serial:open", (port: string, baud: number) => serial.open(port, baud));
  handle("serial:read", (id: number) => serial.read(id)); handle("serial:write", (id: number, bytes: number[]) => serial.write(id, bytes)); handle("serial:close", (id: number) => serial.close(id));
}
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault(); const hadUnsaved = dirty; if (!confirmClose()) return; if (hadUnsaved) abandoned = true; dirty = false; quitting = true;
  void enqueue(async () => {
    // The user explicitly discarded these buffers; remove only this project's draft so restart cannot resurrect it.
    if (abandoned && workspace.root) await recovery.discard(workspace.root).catch((error) => console.error("Recovery draft discard failed", error));
    await Promise.all([tasks.stopAll(), serial.dispose(), language.stop(), terminal.stop(), workspace.close()]);
  }).finally(() => app.quit());
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
  window.on("close", (event) => { const hadUnsaved = dirty; if (!confirmClose()) event.preventDefault(); else { if (hadUnsaved) abandoned = true; dirty = false; } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  routes();
  await tools.load();
  for (const issue of tools.errors) console.error("Tool settings:", issue);
  if (process.env.AETHER_DEV_URL) {
    const url = new URL(process.env.AETHER_DEV_URL);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("开发服务器只能使用本机 HTTP 地址");
    await window.loadURL(url.href);
  } else await window.loadURL("aether://app/index.html");
}).catch((error) => { console.error("Aether startup failed", error); app.exit(1); });
