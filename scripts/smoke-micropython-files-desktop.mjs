import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

// Desktop proof for the read-only board file panel. The app is real; mpremote is the file-backed fake
// (with a virtual device tree) and the port name is fake, so no serial port or board is touched.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-files-desktop-"));
const profile = path.join(temp, "profile");
const exportsDir = path.join(temp, "exports");
const modeFile = path.join(temp, "fs-mode.txt");
await fs.mkdir(profile); await fs.mkdir(exportsDir);
const fake = path.resolve("scripts/fixtures/fake-mpremote.py");
const fakeLog = path.join(temp, "fake-mpremote.log");
const setMode = (value) => fs.writeFile(modeFile, value);
await setMode("ok");
const downloadsBefore = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("aether-micropython-download-"));
const env = {
  ...process.env, AETHER_USER_DATA_DIR: profile, AETHER_MPREMOTE: fake,
  AETHER_FAKE_MPREMOTE_LOG: fakeLog, AETHER_FAKE_MPREMOTE_FS_MODE_FILE: modeFile,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.AETHER_FAKE_MPREMOTE_FS_MODE;
let app;
const saveTarget = (file) => app.evaluate(({ dialog }, target) => {
  globalThis.__aetherSave = { canceled: !target, filePath: target || undefined };
  dialog.showSaveDialog = async () => globalThis.__aetherSave;
  dialog.showMessageBoxSync = () => 1;
}, file);
try {
  app = await electron.launch({ ...(process.env.AETHER_PACKAGED_EXECUTABLE ? { executablePath: process.env.AETHER_PACKAGED_EXECUTABLE, args: ["--no-sandbox"] } : { args: [".", "--no-sandbox"] }), env, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.getByRole("button", { name: "Plugins", exact: true }).first().waitFor();
  await saveTarget("");
  const command = async (text) => { await page.keyboard.press("Control+k"); await page.getByPlaceholder("Search commands, files and actions…").fill(text); await page.keyboard.press("Enter"); };
  const panel = page.locator("[data-micropython-files]");
  const pathLabel = page.locator("[data-micropython-files-path]");
  const download = async (remote) => {
    const button = page.locator('[data-micropython-files-download="' + remote + '"]');
    for (let n = 0; n < 200 && await button.isDisabled(); n++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await button.isDisabled(), false, "download button must be enabled: " + remote);
    // The panel locks itself as soon as the save dialog opens, so a DOM click avoids Playwright's
    // actionability wait racing the disabled state; a user click is unaffected.
    await button.evaluate((element) => element.click());
  };
  const settle = async (pathText) => {
    for (let n = 0; n < 100; n++) {
      if ((await pathLabel.textContent()) === pathText && !(await page.locator("[data-micropython-files]").getByRole("status").filter({ hasText: "正在读取" }).count())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("did not settle on " + pathText + " (now " + (await pathLabel.textContent()) + ")");
  };

  await command("MicroPython: 浏览板载文件");
  await page.getByRole("heading", { name: "板载文件", exact: true }).waitFor();
  await panel.locator("[data-micropython-files-warning]").getByText(/仍会发送中断/).waitFor();
  await page.locator("[data-micropython-files-port]").fill("COM_TEST");
  await page.locator("[data-micropython-files-root]").click();
  await settle("/");
  for (const name of ["boot.py", "lib", "main.py", "空 目录", "数据 记录.txt"]) await page.getByText(name, { exact: true }).first().waitFor();
  await page.locator('[data-micropython-files-file="/数据 记录.txt"]').waitFor();
  console.log("PASS Electron MicroPython files: root listing with Chinese/space names");

  // Empty directory, then back to the root through 上一级.
  await page.locator('[data-micropython-files-dir="/空 目录"]').click();
  await settle("/空 目录");
  await panel.locator("[data-micropython-files-empty]").getByText("该目录为空").waitFor();
  await page.locator("[data-micropython-files-up]").click();
  await settle("/");
  console.log("PASS Electron MicroPython files: empty directory and 上一级 navigation");

  // Level-by-level browsing; the final path is the requested one, not a late reply for a parent.
  await page.locator('[data-micropython-files-dir="/lib"]').click();
  await settle("/lib");
  await page.locator('[data-micropython-files-dir="/lib/sub dir"]').click();
  await settle("/lib/sub dir");
  await page.locator('[data-micropython-files-file="/lib/sub dir/深 层.py"]').waitFor();
  await page.locator("[data-micropython-files-up]").click();
  await settle("/lib");
  await page.locator("[data-micropython-files-up]").click();
  await settle("/");
  console.log("PASS Electron MicroPython files: level-by-level browsing keeps the requested directory");

  // Download through the host save dialog into a new local file.
  const target = path.join(exportsDir, "记录 copy.txt");
  await saveTarget(target);
  await download("/数据 记录.txt");
  await panel.getByText(/已保存 数据 记录\.txt/).waitFor({ timeout: 30000 });
  assert.equal(await fs.readFile(target, "utf8"), "temperature,pressure\r\n21.5,1013.2\r\n");
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("aether-micropython-download-")), downloadsBefore, "no private temp directory remains");
  console.log("PASS Electron MicroPython files: download writes the device bytes to the dialog-issued path");

  // An existing local file is never overwritten.
  const keep = path.join(exportsDir, "keep.txt");
  await fs.writeFile(keep, "KEEP");
  await saveTarget(keep);
  await download("/main.py");
  await panel.getByText(/目标文件已存在，未覆盖/).waitFor({ timeout: 30000 });
  assert.equal(await fs.readFile(keep, "utf8"), "KEEP");
  console.log("PASS Electron MicroPython files: an existing local file is refused, not overwritten");

  // Device-side failure: an error is shown, nothing is written, no temp remains.
  await setMode("fail");
  const broken = path.join(exportsDir, "broken.bin");
  await saveTarget(broken);
  await download("/main.py");
  await panel.getByText(/退出码 5/).waitFor({ timeout: 30000 });
  assert.equal(await fs.stat(broken).catch(() => null), null);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("aether-micropython-download-")), downloadsBefore);
  console.log("PASS Electron MicroPython files: a failed transfer reports the real exit code and writes nothing");

  // Cancellation of a slow transfer.
  await setMode("slow");
  const slowTarget = path.join(exportsDir, "slow.bin");
  await saveTarget(slowTarget);
  await download("/main.py");
  await page.locator('[data-micropython-files-download="/main.py"]').getByText("下载中…").waitFor({ timeout: 30000 });
  await page.locator("[data-micropython-files-cancel]").click();
  await panel.getByText(/操作已取消/).waitFor({ timeout: 30000 });
  assert.equal(await fs.stat(slowTarget).catch(() => null), null);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("aether-micropython-download-")), downloadsBefore);
  console.log("PASS Electron MicroPython files: cancellation stops the transfer and cleans its temp file");

  // Abnormal mpremote output is refused instead of displayed.
  await setMode("mismatch");
  await page.locator("[data-micropython-files] .btn").filter({ hasText: "刷新目录" }).click();
  await panel.getByText(/多个目录头|目录头/).waitFor({ timeout: 30000 });
  await setMode("ok");
  console.log("PASS Electron MicroPython files: a mismatched ls header is refused with an explicit error");

  assert.deepEqual(errors, []);
  await page.screenshot({ path: "smoke-results/micropython-files.png", fullPage: true });
  console.log("PASS Electron MicroPython files: panel reached through the command palette with no page errors");
} finally {
  await app?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
