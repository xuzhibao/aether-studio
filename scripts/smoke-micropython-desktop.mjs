import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Desktop entry proof for the MicroPython run panel. The app is real; mpremote is the file-backed
// Python fixture and the port is a fake name, so no serial port or board is opened.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-desktop-"));
const project = path.join(temp, "project");
const profile = path.join(temp, "profile");
await fs.mkdir(project); await fs.mkdir(profile);
const mainSource = 'print("desktop smoke")\n';
const mainDigest = createHash("sha256").update(mainSource).digest("hex");
await fs.writeFile(path.join(project, "main.py"), mainSource);
const fake = path.resolve("scripts/fixtures/fake-mpremote.py");
const fakeLog = path.join(temp, "fake-mpremote.log");
const env = { ...process.env, AETHER_USER_DATA_DIR: profile, AETHER_MPREMOTE: fake, AETHER_FAKE_MPREMOTE_LOG: fakeLog, AETHER_FAKE_MPREMOTE_MODE: "ok" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ ...(process.env.AETHER_PACKAGED_EXECUTABLE ? { executablePath: process.env.AETHER_PACKAGED_EXECUTABLE, args: ["--no-sandbox"] } : { args: [".", "--no-sandbox"] }), env, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.getByRole("button", { name: "Plugins", exact: true }).first().waitFor();
  await app.evaluate(({ dialog }, { root }) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes("openDirectory") ? root : root] });
    dialog.showSaveDialog = async () => ({ canceled: true });
    dialog.showMessageBoxSync = () => 1;
  }, { root: project });
  const command = async (text) => { await page.keyboard.press("Control+k"); await page.getByPlaceholder("Search commands, files and actions…").fill(text); await page.keyboard.press("Enter"); };
  const entries = async () => (await fs.readFile(fakeLog, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const versionCount = async () => (await entries()).filter((entry) => entry.version).length;
  const waitAvailable = async () => {
    for (let n = 0; n < 100; n++) {
      if (await page.locator('[data-mpremote-available="true"]').count()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("mpremote did not become available");
  };
  await command("Open project folder");
  await page.getByText(project, { exact: true }).first().waitFor();
  await command("MicroPython: 在设备运行已保存的 Python 文件");
  await page.getByRole("heading", { name: "在设备运行 Python", exact: true }).waitFor();
  await page.locator("[data-micropython-warning]").getByText(/软重启/).waitFor();
  await page.locator("[data-mpremote-available]").waitFor();
  await waitAvailable();
  // Re-detect must actually execute the host's --version probe, not reuse the cached tools list.
  const before = await versionCount();
  await page.getByRole("button", { name: /重新检测/ }).click();
  for (let n = 0; n < 100 && (await versionCount()) <= before; n++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await versionCount()) > before, "re-detect must invoke mpremote --version");
  await waitAvailable();
  await page.locator("[data-micropython-file]").selectOption("main.py");
  await page.locator("[data-micropython-port]").fill("COM_TEST");
  const run = page.locator("[data-micropython-run]");
  for (let n = 0; n < 100 && await run.isDisabled(); n++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await run.isDisabled(), false, "an explicit port and a saved .py must enable Run");
  await run.click();
  await page.locator('[data-micropython-task][data-micropython-status="succeeded"]').waitFor({ timeout: 30000 });
  await page.getByText(/\[fake-mpremote\] ran .*script\.py/).waitFor();
  // The tasks:start reply may arrive after the fast terminal event; the UI must keep succeeded.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await page.locator("[data-micropython-task]").getAttribute("data-micropython-status"), "succeeded", "a late start reply must not regress the task to running");
  const runEntries = (await entries()).filter((entry) => !entry.version);
  assert.equal(runEntries.length, 1, "exactly one run command");
  assert.deepEqual(runEntries[0].argv.slice(0, 3), ["connect", "port:COM_TEST", "run"]);
  assert.equal(runEntries[0].file, runEntries[0].argv[3]);
  assert.ok(runEntries[0].file.includes("aether-micropython-run-"), "the run uses the private temp copy");
  assert.equal(runEntries[0].fileSha256, mainDigest, "the executed bytes match the reviewed saved file");
  assert.equal(await fs.stat(runEntries[0].file).catch(() => null), null, "the private copy is removed when the task ends");
  assert.equal(await fs.stat(path.join(project, ".aether")).catch(() => null), null, "the run task must not write a build record");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "smoke-results/micropython-run.png", fullPage: true });
  console.log("PASS Electron MicroPython: command palette entry, warning, real re-detect --version, saved .py selection, explicit port, private verified copy with exit 0 and cleanup");
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
