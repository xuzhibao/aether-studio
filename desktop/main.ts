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
import { SerialLogExportService } from "./serialLog";
import { ToolService } from "./tools";
import { ESPTOOL_TOOL } from "./esp/esptool";
import { inspectEspDevice } from "./esp/inspect";
import { preflightEspUpload } from "./esp/preflight";
import { createEspUploadProvider } from "./esp/upload";
import { FlashService } from "./flash";
import { createEsptoolRunner } from "./plugins/esptool";
import { qemuEsp32c3Tool } from "./simulator/qemu";
import { FirmwareVerificationService, VERIFIED_WRITE_OPTION } from "./simulator/verification";
import { createMicropythonRunProvider } from "./plugins/micropython";
import { MicropythonFilesService } from "./plugins/micropythonFiles";
import { deviceLease, type DeviceLeaseToken } from "./deviceLock";
import { FirmwareDevService } from "./firmwareDev";
import type { ProjectContext } from "../src/plugins/api";
import type { FirmwareDevStartOptions as FirmwareDevStartOptionsInput } from "../shared/firmwareDev";

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
// One arbiter owns the single COM port for the whole host: monitor, task, flash and ESP reads.
// Each entry holds its own token, so a late close or a cancelled operation frees nothing else.
let monitorLease: DeviceLeaseToken | null = null;
let flashLease: DeviceLeaseToken | null = null;
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
const serialLogExport = new SerialLogExportService();
// An unexpected unplug/close must release the port for flash, not leave it reserved forever.
// It also makes a save picker that is already open target a session that no longer exists.
// Only an attempt that actually opened the port changes the retained session; a failed open leaves it intact.
// Only the session's own token is released here; a failed open has no session and releases in the IPC handler.
serial.setOnSessionEnd((opened) => { if (opened) { serialLogExport.invalidate(); deviceLease.release(monitorLease); monitorLease = null; } });
const terminal = new TerminalService(workspace, (state) => emit("terminal:changed", state));
terminal.register(shellProvider);
const language = new LanguageService(workspace, (snapshot) => emit("language:changed", snapshot));
// Tool paths live in the application data directory; plugins declare the tools and their UI.
const tools = new ToolService(() => path.join(app.getPath("userData"), "tools.json"), (id) => {
  void tools.list().then((list) => emit("tools:changed", list)).catch((error) => console.error("Tool settings update failed", error));
  if (id === "clangd") void language.restartForTool("clangd").catch((error) => console.error("clangd restart failed", error));
  // A new esptool path invalidates a prepared restore plan: its capabilities were measured on the old binary.
  if (id === "esptool") flash.invalidatePlan();
});
// esptool is a shared tool identity: the ESP plugin, the preflight and the backup all use it.
tools.define(ESPTOOL_TOOL);
// Espressif QEMU is a host tool identity: the path comes from settings, an environment variable or PATH.
tools.define(qemuEsp32c3Tool);
const platformio = createPlatformioPlugins(tools);
tasks.register(platformio.platformioBuild); tasks.register(platformio.platformioUpload); tasks.register(platformio.platformioCompileDatabase);
// Firmware verification owns the QEMU session and the host evidence record. The deploy provider
// reads that record; the renderer cannot supply or relax it.
const verification = new FirmwareVerificationService({
  tools, workspace, serial, tasks,
  directory: () => path.join(app.getPath("userData"), "firmware-verification"),
  trashItem: (target) => shell.trashItem(target),
  unsaved: () => dirty,
  emit: (status) => emit("firmwareVerification:changed", status),
});
// ESP uploads are verified and journaled inside the task, while the port lease is held.
tasks.register(createEspUploadProvider(tools, workspace, {
  journalRoot: () => path.join(app.getPath("userData"), "esp-journal"),
  // The host-only intent is created by commitDeploy and reachable only through the internal task
  // option; the generic tasks IPC strips that key, so a normal deploy keeps its full plan.
  writeIntent: (options) => verification.takeWriteIntent(options),
  // The gate is required only for a task started by the explicit verified-deploy commit.
  simulation: {
    required: (options) => !!options?.[VERIFIED_WRITE_OPTION],
    evidence: async () => verification.gateEvidence(),
    verify: (evidence, expected, options) => verification.verifyGate(evidence, expected, options),
  },
}));
// mpremote runs one saved project script; it shares the same port lease and task log/cancel path.
tasks.register(createMicropythonRunProvider(tools, workspace));
// Read-only on-board file listing and single-file download; it shares the same port lease.
// Its picker authorizations are scoped to the workspace root the renderer is currently looking at.
const micropythonFiles = new MicropythonFilesService(tools, { workspaceRoot: () => workspace.root });
language.register(createClangdProvider(tools));
// Flash backup/restore shares the single COM port with the monitor and upload tasks.
const esptool = createEsptoolRunner(tools);
const flash = new FlashService(esptool, {
  emit: (snapshot) => emit("flash:changed", snapshot),
  chooseSave: async (suggestedName) => {
    const result = await dialog.showSaveDialog(window, { title: "保存 Flash 备份", defaultPath: path.join(app.getPath("documents"), suggestedName), filters: [{ name: "Flash 镜像", extensions: ["bin"] }] });
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  chooseOpen: async () => {
    const result = await dialog.showOpenDialog(window, { title: "选择 Flash 备份", properties: ["openFile"], filters: [{ name: "Flash 镜像", extensions: ["bin"] }] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  workspaceRoot: () => workspace.root,
  appRoot: () => app.getAppPath(),
  serialBusy: () => serial.isOpen(),
  claim: (port) => { flashLease = deviceLease.claim("flash", port); },
  release: () => { deviceLease.release(flashLease); flashLease = null; },
});
// The automatic firmware-development task: a trusted session over the SAME services above.
// It is explicit-start only and each step is a real host action; the renderer drives nothing itself.
const firmwareDev = new FirmwareDevService({
  workspace, tasks, tools, serial, verification,
  invalidateFlashPlan: () => flash.invalidatePlan(),
  unsaved: () => dirty,
  emit: (view) => emit("firmwareDev:changed", view),
});
const stateFile = () => path.join(app.getPath("userData"), "workspace.json");
const remember = async () => { await fs.mkdir(app.getPath("userData"), { recursive: true }); await fs.writeFile(stateFile(), JSON.stringify({ root: workspace.root })); };
const chooseFolder = async () => { const result = await dialog.showOpenDialog(window, { title: "Open Aether Project Folder", properties: ["openDirectory", "createDirectory"] }); return result.canceled ? null : result.filePaths[0]; };
const beforeSwitch = async () => { serialLogExport.invalidate(); await firmwareDev.dispose(); await verification.dispose(); verification.clear(); await tasks.stopAll(); await micropythonFiles.dispose(); await flash.dispose(); await serial.dispose(); await language.stop(); await terminal.stop(); };
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
  handle("workspace:files:accept", (name: string, expected?: string | null) => enqueue(() => workspace.accept(name, expected)));
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
  // ESP operations run only on an explicit user action; both are read-only and take the same port lease.
  handle("esp:inspect", (port: string) => inspectEspDevice(port, tools));
  // UI preview only. The authoritative check runs inside the esp.upload task; there is no option to relax it.
  handle("esp:preflight", (options: { environment?: string; port: string }) => {
    const root = workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    return preflightEspUpload({ root, environment: options.environment, port: options.port, workspace, tools, platformio: tools.executable("platformio") });
  });
  // Firmware verification: QEMU run, host evidence, explicit verified-deploy preview/commit and the
  // independent device challenge. The preview never arms the generic deploy dialog.
  handle("firmwareVerification:status", () => verification.status());
  handle("firmwareVerification:startSimulation", (options: { environment: string; boots?: number; timeoutMs?: number }) => enqueue(() => verification.runSimulation(options)));
  handle("firmwareVerification:cancel", () => verification.cancel());
  handle("firmwareVerification:previewDeploy", (options: { environment: string; port: string }) => enqueue(() => verification.previewDeploy(options)));
  handle("firmwareVerification:commitDeploy", async (options: { token: string; environment: string; port: string }) => {
    // A pending Flash restore plan was diffed against the pre-write device; this write invalidates it,
    // exactly like the generic task and serial entries do.
    flash.invalidatePlan();
    // Claim before any await so a monitor opening the port cannot slip between the check and the write.
    const token = deviceLease.claim("task");
    try {
      return await enqueue(async () => {
        const intent = await verification.commitDeploy(options);
        try {
          const task = await tasks.start("esp.upload", { port: intent.port, environment: intent.environment, [VERIFIED_WRITE_OPTION]: intent.id }, token);
          return { taskId: task.id };
        } catch (error) {
          // A refusal before a process exists has no write to settle; the one-shot intent is dropped.
          verification.abortWrite(intent.id);
          throw error;
        }
      });
    } catch (error) { deviceLease.release(token); throw error; }
  });
  handle("firmwareVerification:disarm", () => enqueue(async () => verification.disarm()));
  // Automatic firmware development: start/stop are not queued behind a long step, so a stop can
  // actually interrupt the process or lease it names.
  handle("firmwareDev:status", () => firmwareDev.view());
  handle("firmwareDev:start", (options: FirmwareDevStartOptionsInput) => firmwareDev.start(options));
  handle("firmwareDev:stop", () => firmwareDev.stop());
  handle("firmwareDev:build", () => firmwareDev.build());
  handle("firmwareDev:simulate", () => firmwareDev.simulate());
  handle("firmwareDev:preview", () => firmwareDev.preview());
  handle("firmwareDev:write", () => firmwareDev.write());
  handle("firmwareDev:challenge", () => firmwareDev.challenge());
  handle("firmwareDev:applyEdit", (options: { path: string; expected: string; content: string }) => firmwareDev.applyEdit(options));
  handle("firmwareVerification:runDevice", (options: { port: string; transport?: "uart0" | "usb-serial-jtag"; timeoutMs?: number }) => enqueue(() => verification.runDevice(options)));
  handle("tasks:start", async (provider: string, options: Record<string, string> = {}) => {
    // Invalidate first: a failed snapshot emit must not leave a claimed token with no owner to release it.
    flash.invalidatePlan();
    // Claim synchronously at the IPC entry: the task's own await-heavy start cannot slip past a monitor.
    const token = deviceLease.claim("task");
    // The verified-write marker is host-only. A renderer task (generic deploy or anything else) cannot
    // smuggle it in, so the dedicated intent is never reachable from this path.
    const safeOptions = { ...options };
    delete safeOptions[VERIFIED_WRITE_OPTION];
    try {
      return await enqueue(() => tasks.start(provider, safeOptions, token));
    }
    // The task releases this token when its process really exits; a refusal before spawn frees it here.
    catch (error) { deviceLease.release(token); throw error; }
  });
  handle("tasks:cancel", (id: string) => tasks.cancel(id));
  // Read-only board files: list one directory, or download one file to a host-chosen new local file.
  handle("micropython:files:list", (port: string, path: string) => micropythonFiles.list(port, path));
  handle("micropython:files:chooseDownloadPath", (port: string, remote: string, suggestedName: string) => micropythonFiles.choose(port, remote, suggestedName, async (name) => {
    const result = await dialog.showSaveDialog(window, { title: "保存设备文件", defaultPath: path.join(app.getPath("documents"), name), properties: ["showOverwriteConfirmation", "createDirectory"] });
    return result.canceled || !result.filePath ? null : result.filePath;
  }));
  handle("micropython:files:download", (token: string) => micropythonFiles.download(token));
  handle("micropython:files:cancel", () => micropythonFiles.cancel());
  handle("micropython:files:invalidate", () => micropythonFiles.invalidate());
  handle("tasks:environments", (provider: string) => tasks.environments(provider));
  handle("tasks:list", () => tasks.list());
  handle("serial:list", () => serial.list());
  handle("serial:open", async (port: string, baud: number) => {
    if (typeof port !== "string" || !port.trim()) throw new Error("无效的串口参数");
    // Invalidate before claiming: a failed snapshot emit must not leave a token nobody releases.
    flash.invalidatePlan();
    // Claimed before the first await, with the real port, so an esptool entry is refused by the lease
    // instead of colliding with the OS handle. The token is stored before open: an unplug that ends
    // the session while open() is still settling must release this same token, not a newer one.
    const token = deviceLease.claim("monitor", port);
    monitorLease = token;
    try { return await serial.open(port, baud); }
    catch (error) { deviceLease.release(token); if (monitorLease === token) monitorLease = null; throw error; }
  });
  handle("serial:read", (id: number) => serial.read(id));
  handle("serial:write", (id: number, bytes: number[]) => serial.write(id, bytes));
  handle("serial:close", async (id: number) => {
    const closed = await serial.close(id);
    // A stale id, or a close that threw, must not free a newer monitor session's lease.
    if (closed) { deviceLease.release(monitorLease); monitorLease = null; }
  });
  // Bounded native serial diagnostic export: one picker-issued new file, never an overwrite.
  handle("serialLog:save", (request) => serialLogExport.save(request, async (suggestedName: string) => {
    const result = await dialog.showSaveDialog(window, { title: "保存串口诊断日志", defaultPath: path.join(app.getPath("documents"), suggestedName), filters: [{ name: "文本文件", extensions: ["txt"] }], properties: ["createDirectory"] });
    return result.canceled || !result.filePath ? null : result.filePath;
  }));
  handle("serialLog:invalidate", () => serialLogExport.invalidate());
  // Flash operations acquire the same lease synchronously inside the service.
  handle("flash:snapshot", () => flash.snapshot());
  handle("flash:toolStatus", () => tools.status("esptool"));
  handle("flash:capabilities", () => flash.capabilities());
  handle("flash:describe", (port: string) => flash.describeExclusive(port));
  handle("flash:chooseBackupPath", (suggestedName: string) => flash.chooseBackupPath(suggestedName));
  handle("flash:chooseBackupFile", () => flash.chooseBackupFile());
  handle("flash:readMetadata", (backupPath: string) => flash.readMetadata(backupPath));
  handle("flash:startBackup", (options) => flash.startBackup(options));
  handle("flash:prepareRestore", (options) => flash.prepareRestore(options));
  handle("flash:executeRestore", (planId: string, confirmation: string) => {
    return flash.executeRestore(planId, confirmation);
  });
  handle("flash:cancel", () => flash.cancel());
}
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault(); const hadUnsaved = dirty; if (!confirmClose()) return; if (hadUnsaved) abandoned = true; dirty = false; quitting = true;
  void enqueue(async () => {
    // The user explicitly discarded these buffers; remove only this project's draft so restart cannot resurrect it.
    if (abandoned && workspace.root) await recovery.discard(workspace.root).catch((error) => console.error("Recovery draft discard failed", error));
    serialLogExport.invalidate();
    await Promise.all([firmwareDev.dispose(), verification.dispose(), tasks.stopAll(), micropythonFiles.dispose(), flash.dispose(), serial.dispose(), language.stop(), terminal.stop(), workspace.close()]);
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
  window = new BrowserWindow({ width: 1728, height: 1080, minWidth: 1180, minHeight: 600, frame: false, backgroundColor: "#F5F6F8", webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.on("close", (event) => { const hadUnsaved = dirty; if (!confirmClose()) event.preventDefault(); else { if (hadUnsaved) abandoned = true; dirty = false; void micropythonFiles.invalidate(); } });
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
