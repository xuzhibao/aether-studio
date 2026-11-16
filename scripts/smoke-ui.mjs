import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const server = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "1421", "--strictPort"], { stdio: "pipe", detached: process.platform !== "win32" });
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
let browser;
let page;
const errors = [];
await mkdir("smoke-results", { recursive: true });
try {
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { if ((await fetch("http://127.0.0.1:1421")).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Preview did not start: ${serverLog}`);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  page = await browser.newPage({ viewport: { width: 1728, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("http://127.0.0.1:1421");
  const nav = page.locator("nav");
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByText("本地内置插件 · 7 / 7 已启用", { exact: true }).waitFor();
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
  await page.screenshot({ path: "smoke-results/workspace.png", fullPage: true });
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
  await dialog.getByRole("button", { name: /^Monaco 编辑器/ }).click();
  await dialog.getByRole("button", { name: "停用", exact: true }).click();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByText("编辑器插件已停用，请在 Plugins 中启用。", { exact: true }).waitFor();
  await nav.getByRole("button", { name: "Plugins", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await dialog.getByRole("button", { name: /^ESP32 示例工程/ }).click();
  await dialog.getByRole("button", { name: "启用", exact: true }).click();
  await page.screenshot({ path: "smoke-results/plugins.png", fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await nav.getByRole("button", { name: "Demo Simulation 说明", exact: true }).click();
  await page.getByRole("heading", { name: "Demo Simulation", exact: true }).waitFor();
  assert.deepEqual(errors, [], "no browser console errors");
  console.log("PASS UI: plugin settings/dependencies/toggle, plugin panel/menu, board selection, create project, add/drag parts, Monaco edit, demo console output, save/reload, disabled editor, no console errors");
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: "smoke-results/failure.png", fullPage: true });
    await writeFile("smoke-results/failure.txt", `${error.stack}\n\nConsole errors:\n${errors.join("\n")}\n\n${await page.locator("body").innerText()}`);
  }
  throw error;
} finally {
  await browser?.close();
  if (process.platform === "win32") server.kill();
  else { try { process.kill(-server.pid, "SIGTERM"); } catch {} }
}
