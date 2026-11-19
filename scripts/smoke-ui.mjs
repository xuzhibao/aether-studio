import { startWebSocketPeer } from "./websocket-peer.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium } from "playwright";

// Run Vite directly: spawning npm is not portable on Windows without a shell.
// Pick a free port so a preview server from another checkout cannot satisfy the readiness check.
const port = await new Promise((resolve, reject) => { const probe = createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
const origin = `http://127.0.0.1:${port}`;
const resultsDir = process.env.AETHER_SMOKE_RESULTS ?? "smoke-results";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "pipe", detached: process.platform !== "win32" });
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
let networkPeer;
let browser;
let page;
const errors = [];
await mkdir(resultsDir, { recursive: true });
try {
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Preview did not start: ${serverLog}`);
  networkPeer = await startWebSocketPeer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  page = await browser.newPage({ viewport: { width: 1728, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(origin);
  // Browser builds expose the explorer but never pretend disk file operations succeeded.
  await page.getByText("磁盘文件操作仅在桌面端打开的工程目录中可用。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "New file", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "New folder", exact: true }).isDisabled(), true);
  const nav = page.locator("nav");
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByText("本地内置插件 · 16 / 16 已启用", { exact: true }).waitFor();
  // The ESP device plugin exposes its read-only panel and the esptool setting in the browser too.
  await dialog.getByRole("button", { name: /^ESP 设备检测/ }).click();
  await dialog.getByText("devices/esp32", { exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-tool-id="esptool"]').getAttribute("data-tool-available"), "false");
  // The MicroPython plugin contributes the device-run entry and the mpremote path setting.
  await dialog.getByRole("button", { name: /^MicroPython/ }).click();
  await dialog.getByText("toolchains/micropython", { exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-tool-id="mpremote"]').getAttribute("data-tool-available"), "false");
  // Browser preview cannot reach desktop tools; the plugin settings must say so instead of pretending.
  await dialog.getByRole("button", { name: /^PlatformIO/ }).click();
  const platformioTool = dialog.locator('[data-tool-id="platformio"]');
  await platformioTool.waitFor();
  assert.equal(await platformioTool.getAttribute("data-tool-available"), "false");
  await platformioTool.getByText(/桌面工具仅在安装版/).first().waitFor();
  assert.equal(await platformioTool.locator("input").count(), 0);
  await dialog.getByRole("button", { name: /^C\/C\+\+ · clangd/ }).click();
  assert.equal(await dialog.locator('[data-tool-id="clangd"]').getAttribute("data-tool-available"), "false");
  await dialog.getByRole("button", { name: /^Demo Simulation/ }).click();
  await dialog.getByText("simulators/demo", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  assert.equal(await nav.getByRole("button", { name: "Demo Simulation 说明", exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await dialog.getByRole("button", { name: /^ESP32-S3 DevKitC-1/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  assert.match(await dialog.getByRole("alert").innerText(), /请先停用/);
  await dialog.getByRole("button", { name: "使用此开发板创建工程" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Smoke ESP32-S3");
  await dialog.getByRole("button", { name: /^Blank workspace/ }).click();
  await dialog.getByRole("button", { name: "Create Project", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-component-kind]").count(), 1);
  for (const [search, name] of [["BME280", /^BME280/], ["OLED", /^OLED/]]) {
    await nav.getByRole("button", { name: /^Components/ }).click();
    await page.getByPlaceholder("Search components…").fill(search);
    await page.getByRole("button", { name }).click();
    await page.getByPlaceholder("Search components…").waitFor({ state: "hidden" });
    await page.locator(`[data-component-kind="${search === "BME280" ? "bme280" : "oled"}"]`).waitFor();
  }
  assert.equal(await page.locator("[data-component-kind]").count(), 3);
  const part = page.locator('[data-component-kind="bme280"]');
  const rect = await part.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 45, rect.y + rect.height / 2 + 35, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("tab", { name: "main.py", exact: true }).click();
  await page.locator(".monaco-editor .view-lines").first().waitFor();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n# smoke: persisted edit\n");
  await page.keyboard.press("Control+s");
  await page.getByRole("button", { name: "Run Simulation", exact: true }).click();
  await page.getByText("Demo Simulation started · generated data only", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Serial Monitor", exact: true }).click();
  await page.getByText(/\[Demo Simulation\] T=/).first().waitFor();
  await page.keyboard.press("Control+s");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("aether.projects.v1")));
  const id = stored.activeProjectId;
  assert.equal(stored.projects.find((p) => p.id === id).name, "Smoke ESP32-S3");
  assert.ok(stored.workspaces[id].files["main.py"].includes("# smoke: persisted edit"));
  assert.equal(stored.workspaces[id].components.length, 3);
  assert.notEqual(stored.workspaces[id].components.find((c) => c.kind === "bme280").x, 172);
  await page.screenshot({ path: `${resultsDir}/workspace.png`, fullPage: true });
  await page.reload();
  await page.getByRole("tab", { name: "main.py", exact: true }).click();
  await page.locator(".monaco-editor .view-lines").first().waitFor();
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem("aether.projects.v1")));
  assert.equal(restored.activeProjectId, id);
  assert.equal(restored.workspaces[id].files["main.py"], stored.workspaces[id].files["main.py"]);
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Monaco 编辑器/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  assert.match(await dialog.getByRole("alert").innerText(), /请先停用/);
  await dialog.getByRole("button", { name: /^ESP32 示例工程/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: /^PlatformIO/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: /^C\/C\+\+ · clangd/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: /^Monaco 编辑器/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByText("编辑器插件已停用，请在 Plugins 中启用。", { exact: true }).waitFor();
  // The browser must say the device run needs the desktop app instead of faking a run.
  await nav.getByRole("button", { name: "在设备运行 Python", exact: true }).click();
  await page.getByText("在设备上运行 Python 需要 Electron 桌面端", { exact: false }).waitFor();
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await dialog.getByRole("button", { name: /^ESP32 示例工程/ }).click();
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await dialog.getByRole("button", { name: /^PlatformIO/ }).click();
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await dialog.getByRole("button", { name: /^C\/C\+\+ · clangd/ }).click();
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await page.screenshot({ path: `${resultsDir}/plugins.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await nav.getByRole("button", { name: "Demo Simulation 说明", exact: true }).click();
  await page.getByRole("heading", { name: "Demo Simulation", exact: true }).waitFor();
  const downloadEvent = page.waitForEvent("download");
  await page.keyboard.press("Control+Shift+e");
  const download = await downloadEvent;
  assert.ok(download.suggestedFilename().endsWith(".aether"));
  const portable = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(portable.format, "aether-studio");
  assert.equal(portable.workspace.components.length, 3);
  assert.ok(portable.workspace.files["main.py"].includes("# smoke: persisted edit"));
  portable.project.name = "导入的环境工程";
  const chooserEvent = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+Shift+o");
  await (await chooserEvent).setFiles({ name: "portable.aether", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(portable)) });
  await page.getByRole("button").filter({ hasText: "导入的环境工程" }).first().waitFor();
  const imported = await page.evaluate(() => JSON.parse(localStorage.getItem("aether.projects.v1")));
  assert.notEqual(imported.activeProjectId, id);
  assert.equal(imported.workspaces[imported.activeProjectId].files["main.py"], stored.workspaces[id].files["main.py"]);
  assert.equal(imported.workspaces[imported.activeProjectId].components.length, 3);
  assert.equal(imported.workspaces[id].files["main.py"], stored.workspaces[id].files["main.py"]);
  const invalidChooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+Shift+o");
  await (await invalidChooser).setFiles({ name: "invalid.aether", mimeType: "application/json", buffer: Buffer.from('{"version":999}') });
  await page.getByText(/不支持的 Aether 工程格式/).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("aether.projects.v1")).activeProjectId), imported.activeProjectId);
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const fontInput = page.getByRole("spinbutton", { name: "Editor font size" });
  await fontInput.press("Control+a");
  await fontInput.pressSequentially("16");
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  assert.equal(await page.getByRole("spinbutton", { name: "Editor font size" }).inputValue(), "16");
  assert.equal(await page.getByRole("checkbox", { name: "Reduce motion" }).isChecked(), true);
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  assert.equal(await page.getByRole("spinbutton", { name: "Editor font size" }).inputValue(), "12.5");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${resultsDir}/imported-project.png`, fullPage: true });
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^OpenAI Compatible API/ }).click();
  await dialog.getByLabel("完整 Chat Completions URL").fill("https://agent-fixture.example/v1/chat/completions");
  await dialog.getByLabel("模型名称").fill("tool-fixture");
  // "Test connection" uses the form's own adapter against a local route fixture (no online model).
  const probeUrl = "https://agent-fixture.example/v1/probe";
  const probeCors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization" };
  let probeStatus = 200;
  const probeRequests = [];
  await page.route(probeUrl, async (route) => {
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers: probeCors }); return; }
    probeRequests.push({ body: route.request().postDataJSON(), authorization: route.request().headers()["authorization"] ?? "" });
    if (probeStatus !== 200) { await route.fulfill({ status: probeStatus, headers: probeCors, json: { error: { message: "fixture rejected" } } }); return; }
    await route.fulfill({ headers: probeCors, json: { model: "probe-response-model", choices: [{ message: { content: "pong" } }] } });
  });
  // The GOAT prefill only fills the form; it never connects by itself.
  await dialog.getByRole("button", { name: "填入 GOAT 端点", exact: true }).click();
  assert.equal(await dialog.getByLabel("完整 Chat Completions URL").inputValue(), "https://api.commandcode.ai/provider/v1/chat/completions");
  assert.equal(await dialog.getByLabel("模型名称").inputValue(), "deepseek/deepseek-v4.1-flash");
  await dialog.getByLabel("完整 Chat Completions URL").fill(probeUrl);
  await dialog.getByLabel("模型名称").fill("probe-form-model");
  await dialog.getByLabel("API Key（仅本次会话）").fill("smoke-session-key-123");
  await dialog.locator('[data-provider-test]').getByText(/API Key 只保存在本次会话内存/).waitFor();
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await dialog.locator('[data-provider-test="success"]').waitFor();
  await dialog.getByText(/连接成功 · 响应模型 probe-response-model/).waitFor();
  assert.equal(probeRequests.length, 1);
  assert.equal(probeRequests[0].authorization, "Bearer smoke-session-key-123");
  assert.equal(probeRequests[0].body.model, "probe-form-model");
  assert.deepEqual(probeRequests[0].body.messages, [{ role: "user", content: "ping" }]);
  assert.equal(Object.hasOwn(probeRequests[0].body, "tools"), false);
  assert.ok(!(await page.evaluate(() => localStorage.getItem("aether.plugins.settings") ?? "")).includes("smoke-session-key-123"), "the session key is not persisted");
  probeStatus = 401;
  await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
  await dialog.locator('[data-provider-test="error"]').waitFor();
  await dialog.getByText(/连接失败：AI API 请求失败：HTTP 401/).waitFor();
  await dialog.getByLabel("完整 Chat Completions URL").fill("https://agent-fixture.example/v1/chat/completions");
  await dialog.getByLabel("模型名称").fill("tool-fixture");
  await page.unroute(probeUrl);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  let fixtureMode = "apply";
  let fixtureTurn = 0;
  let finishHeldRequest;
  let heldRequestStarted;
  const requestHeld = new Promise((resolve) => { heldRequestStarted = resolve; });
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization" };
  await page.route("https://agent-fixture.example/v1/chat/completions", async (route) => {
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const body = route.request().postDataJSON();
    assert.ok(body.tools.some((tool) => tool.function.name === "project_read_file"));
    if (fixtureMode === "cancel") {
      await new Promise((resolve) => { finishHeldRequest = resolve; heldRequestStarted(); });
      await route.fulfill({ headers, json: { choices: [{ message: { content: "Cancelled HTTP fixture" } }] } }).catch(() => {});
      return;
    }
    let message;
    if (fixtureMode === "apply" && fixtureTurn === 0) message = { content: null, tool_calls: [{ id: "read-main", type: "function", function: { name: "project_read_file", arguments: JSON.stringify({ path: "main.py" }) } }] };
    else if ((fixtureMode === "apply" && fixtureTurn === 1) || (fixtureMode === "reject" && fixtureTurn === 0)) message = { content: null, tool_calls: [{ id: "propose-files", type: "function", function: { name: "project_propose_files", arguments: JSON.stringify({ summary: "HTTP fixture: review these file edits", files: fixtureMode === "apply" ? [{ path: "main.py", content: portable.workspace.files["main.py"] + "\n# approved fixture\n" }, { path: "notes.py", content: "# new file from reviewed HTTP fixture\n" }] : [{ path: "notes.py", content: "# rejected fixture\n" }] }) } }] };
    else message = { content: "HTTP fixture: modification is pending review, no files have been written." };
    fixtureTurn++;
    await route.fulfill({ headers, json: { choices: [{ message }] } });
  });
  await page.getByRole("combobox", { name: "Agent mode" }).selectOption("api-tools");
  const composer = page.getByPlaceholder("Ask about the code, circuit or debugging…");
  await composer.fill("Propose a file edit (HTTP fixture test)");
  await composer.press("Control+Enter");
  await page.getByRole("button", { name: "预览文件修改", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("aether.projects.v1")).workspaces[JSON.parse(localStorage.getItem("aether.projects.v1")).activeProjectId].files["main.py"]), portable.workspace.files["main.py"]);
  await page.getByRole("button", { name: "预览文件修改", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "notes.py (新文件)", exact: true }).click();
  await page.screenshot({ path: `${resultsDir}/agent-review.png`, fullPage: true });
  await dialog.getByRole("button", { name: "应用修改", exact: true }).click();
  await page.keyboard.press("Control+s");
  const approved = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("aether.projects.v1")); return s.workspaces[s.activeProjectId].files; });
  assert.ok(approved["main.py"].includes("# approved fixture"));
  assert.ok(approved["notes.py"].includes("new file from reviewed HTTP fixture"));
  fixtureMode = "reject"; fixtureTurn = 0;
  await composer.fill("Reject the next file edit (HTTP fixture test)");
  await composer.press("Control+Enter");
  await page.getByRole("button", { name: "预览文件修改", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "拒绝建议", exact: true }).click();
  await page.keyboard.press("Control+s");
  assert.equal(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("aether.projects.v1")); return s.workspaces[s.activeProjectId].files["notes.py"]; }), approved["notes.py"]);
  fixtureMode = "cancel";
  await composer.fill("Wait for API (HTTP fixture cancellation test)");
  await composer.press("Control+Enter");
  await requestHeld;
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("请求已取消；未自动应用文件修改。", { exact: true }).waitFor();
  finishHeldRequest?.();
  await nav.getByRole("button", { name: "Devices", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("请在 Electron 桌面端使用原生串口；浏览器不提供此能力。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "建立连接", exact: true }).isDisabled(), true);
  await dialog.getByRole("combobox", { name: "通信插件" }).selectOption("websocket");
  assert.equal(await dialog.getByRole("spinbutton", { name: "波特率" }).count(), 0, "protocol parameters come from the selected plugin");
  await dialog.getByRole("textbox", { name: "WebSocket URL" }).fill(networkPeer.url);
  await dialog.getByRole("button", { name: "建立连接", exact: true }).click();
  await dialog.getByText(/^已连接 ws:\/\/127/).waitFor();
  await dialog.getByRole("button", { name: "打开 Serial Monitor", exact: true }).click();
  await page.getByText("RX · WebSocket fixture: ready", { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Serial source", exact: true }).inputValue(), "device");
  const transmitter = page.getByRole("textbox", { name: "Serial text", exact: true });
  await page.getByRole("combobox", { name: "Line ending", exact: true }).selectOption("\r\n");
  await transmitter.fill("温度:24.6"); await transmitter.press("Enter");
  await page.getByText("RX · WebSocket fixture text: 温度:24.6", { exact: true }).waitFor();
  await page.getByText("RX · WebSocket fixture binary: 温度:24.6", { exact: true }).waitFor();
  assert.deepEqual(networkPeer.received[0], { text: "温度:24.6\r\n", binary: true });
  await page.getByRole("button", { name: "Pause display", exact: true }).click();
  await transmitter.fill("paused-network-sample"); await transmitter.press("Enter");
  for (let n = 0; n < 100 && networkPeer.received.length < 2; n++) await new Promise((done) => setTimeout(done, 20));
  assert.equal(networkPeer.received.length, 2);
  assert.equal(await page.getByText("RX · WebSocket fixture text: paused-network-sample", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Resume display", exact: true }).click();
  await page.getByText("RX · WebSocket fixture binary: paused-network-sample", { exact: true }).waitFor();
  // Scrollback regression. Every line below is generated by the local WebSocket fixture, not hardware.
  // The device display keeps a 500-row ring, so its length stops changing while row identities keep replacing.
  const serialScroller = page.locator("[data-serial-scroller]").first();
  const distanceFromBottom = () => serialScroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const topVisibleLine = () => serialScroller.evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll("[data-serial-line]")) {
      if (row.getBoundingClientRect().bottom > top + 1) return { id: row.getAttribute("data-serial-line"), text: row.innerText };
    }
    return null;
  });
  const pinnedToBottom = () => page.waitForFunction(() => {
    const el = document.querySelector("[data-serial-scroller]");
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
  });
  await transmitter.fill("fixture-burst:520"); await transmitter.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-serial-line]").length === 500, null, { timeout: 20000 });
  await page.getByText("RX · WebSocket fixture burst 520/520", { exact: true }).waitFor({ timeout: 20000 });
  await pinnedToBottom();
  const firstCappedRow = await page.locator("[data-serial-line]").first().innerText();
  // One more line at the same 500-row length must evict the oldest row and keep the viewport at the tail.
  await transmitter.fill("fixture-after-cap"); await transmitter.press("Enter");
  await page.getByText("RX · WebSocket fixture binary: fixture-after-cap", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-serial-line]").count(), 500);
  assert.notEqual(await page.locator("[data-serial-line]").first().innerText(), firstCappedRow, "the ring must be replacing rows by identity");
  assert.ok((await distanceFromBottom()) <= 8, "follow must stay pinned after a constant-length replacement");
  // Deliberately scroll up: following stops and incoming lines must not yank the inspected rows away.
  await serialScroller.hover();
  await page.mouse.wheel(0, -600);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
  assert.ok((await distanceFromBottom()) > 8);
  const inspectedRow = await topVisibleLine();
  await transmitter.fill("fixture-while-detached"); await transmitter.press("Enter");
  await page.getByText("RX · WebSocket fixture binary: fixture-while-detached", { exact: true }).waitFor();
  assert.ok((await distanceFromBottom()) > 8, "incoming lines must not return a detached viewport to the tail");
  assert.deepEqual(await topVisibleLine(), inspectedRow, "the row under inspection must stay in place");
  assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 1);
  // The explicit control returns to the tail and resumes following.
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
  await pinnedToBottom();
  assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0);
  // Scrolling back to the bottom also resumes following.
  await serialScroller.hover();
  await page.mouse.wheel(0, -600);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
  // Wheel over the list itself, not the floating control, so the list keeps the gesture.
  await serialScroller.hover();
  await page.mouse.wheel(0, 5000);
  await pinnedToBottom();
  assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0);
  // Pause freezes displayed rows without stopping RX; Resume returns to live output at the tail.
  await page.getByRole("button", { name: "Pause display", exact: true }).click();
  await transmitter.fill("fixture-paused-at-tail"); await transmitter.press("Enter");
  for (let n = 0; n < 100 && !networkPeer.received.some((entry) => entry.text.includes("fixture-paused-at-tail")); n++) await new Promise((done) => setTimeout(done, 20));
  assert.ok(networkPeer.received.some((entry) => entry.text.includes("fixture-paused-at-tail")), "RX must continue while the display is paused");
  assert.equal(await page.getByText("RX · WebSocket fixture binary: fixture-paused-at-tail", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0, "paused display is not a detached viewport");
  await page.getByRole("button", { name: "Resume display", exact: true }).click();
  await page.getByText("RX · WebSocket fixture binary: fixture-paused-at-tail", { exact: true }).waitFor();
  await pinnedToBottom();
  assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0);
  // Filtering only changes the visible subset; returning to All keeps the tail view coherent.
  await page.locator(".seg").getByRole("button", { name: "Warnings", exact: true }).click();
  await page.getByText("No serial output in this view.", { exact: true }).waitFor();
  await page.locator(".seg").getByRole("button", { name: "All", exact: true }).click();
  await page.getByText("RX · WebSocket fixture binary: fixture-paused-at-tail", { exact: true }).waitFor();
  await pinnedToBottom();
  // Clear works from a detached viewport too, and the next line follows again.
  await serialScroller.hover();
  await page.mouse.wheel(0, -600);
  await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear serial output", exact: true }).click();
  await page.getByText("No serial output in this view.", { exact: true }).waitFor();
  await transmitter.fill("fixture-after-clear"); await transmitter.press("Enter");
  await page.getByText("RX · WebSocket fixture binary: fixture-after-clear", { exact: true }).waitFor();
  await pinnedToBottom();
  assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0);
  // Clear resets the displayed buffer; the transport stays connected for later assertions.
  await page.getByRole("button", { name: "Clear serial output", exact: true }).click();
  await page.getByText("No serial output in this view.", { exact: true }).waitFor();
  await page.screenshot({ path: `${resultsDir}/websocket-browser.png`, fullPage: true });
  await page.getByRole("button", { name: "Clear serial output", exact: true }).click();
  await page.getByText("No serial output in this view.", { exact: true }).waitFor();
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  await dialog.getByRole("button", { name: /^WebSocket 通信/ }).click();
  await dialog.getByText("transports/websocket", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByText(/连接未建立。请在 Manage connection/).waitFor();
  await nav.getByRole("button", { name: "Devices", exact: true }).click();
  await dialog.getByRole("button", { name: "管理插件", exact: true }).click();
  await dialog.getByRole("button", { name: /^桌面串口/ }).click();
  await dialog.getByText("transports/native-serial", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await nav.getByRole("button", { name: "Devices", exact: true }).click();
  await dialog.getByText("没有已启用的通信插件。", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  // Deploy: a PlatformIO project must offer an explicit port field, OS enumeration is not board identification,
  // and the browser preview must not pretend to run an upload.
  await page.locator("header button").filter({ hasText: "Aether Studio" }).first().click();
  await page.getByRole("menuitem", { name: /New Project/ }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("Deploy Smoke");
  await dialog.getByRole("button", { name: /^ESP32-S3 C\+\+/ }).click();
  await dialog.getByRole("button", { name: "Create Project", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Deploy to Device", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Deploy to device", exact: true }).waitFor();
  await dialog.getByText(/不提供此能力|不提供端口枚举|未启用桌面串口插件/).waitFor();
  await dialog.getByText(/不能据此判断开发板型号或固件/).waitFor();
  const uploadPort = dialog.getByLabel("Upload port", { exact: true });
  await uploadPort.fill("COM_TEST");
  assert.equal(await uploadPort.inputValue(), "COM_TEST", "manual port input stays available");
  assert.equal(await dialog.getByRole("button", { name: "开始构建并烧录", exact: true }).isDisabled(), true, "browser preview must not fake an upload");
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  // Chromium reports the intentional 401 connection-test probe as a resource error; only that one is expected.
  assert.deepEqual(errors.filter((message) => !/status of 401 \(Unauthorized\)/.test(message)), [], "no unexpected browser console errors");
  console.log("PASS UI: plugin settings/dependencies/toggle, AI test-connection success/401 with GOAT prefill and non-persisted key, plugin panel/menu, board selection, create project, add/drag parts, Monaco edit, demo console output, save/reload, disabled editor, portable export/import, invalid import, layout persistence/reset, tool calls and reviewed file edits/rejection/cancellation via HTTP fixtures, real WebSocket text/binary round trip, 500-row tail follow with constant-length replacement, scroll-away inspection, Jump to latest/return-to-bottom, pause/filter/clear and disable cleanup, explicit deploy port selection without fake browser upload, no unexpected console errors");
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `${resultsDir}/failure.png`, fullPage: true });
    await writeFile(`${resultsDir}/failure.txt`, `${error.stack}\n\nConsole errors:\n${errors.join("\n")}\n\n${await page.locator("body").innerText()}`);
  }
  throw error;
} finally {
  await browser?.close();
  await networkPeer?.close();
  if (process.platform === "win32") server.kill();
  else { try { process.kill(-server.pid, "SIGTERM"); } catch {} }
}
