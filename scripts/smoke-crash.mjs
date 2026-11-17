import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Real abnormal-exit test: the app process is SIGKILLed, then a fresh process reads the draft.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-crash-"));
const root = path.join(temp, "project");
const newRoot = path.join(temp, "recovered-project");
const profile = path.join(temp, "profile");
const results = "smoke-results";
await fs.mkdir(path.join(root, "src"), { recursive: true });
await fs.mkdir(profile);
await fs.mkdir(newRoot);
await fs.mkdir(results, { recursive: true });
const sourceFile = "src/main.cpp";
const diskPath = path.join(root, sourceFile);
const original = "#include <iostream>\nint main() { return 0; }\n";
await fs.writeFile(diskPath, original);
await fs.writeFile(path.join(root, "README.md"), "崩溃恢复测试工程\n");

let app, page;
const errors = [];
const env = { ...process.env, AETHER_USER_DATA_DIR: profile, TEMP: path.join(temp, "tmp"), TMP: path.join(temp, "tmp") };
delete env.ELECTRON_RUN_AS_NODE;
await fs.mkdir(env.TEMP, { recursive: true });

const launch = async () => {
  app = await electron.launch({ args: [".", "--no-sandbox"], env, timeout: 30000 });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push("pageerror: " + (error.stack ?? error.message)));
  page.on("console", (message) => { if (message.type() === "error") errors.push("console.error: " + message.text() + " @ " + JSON.stringify(message.location())); });
  await page.getByRole("button", { name: "Plugins", exact: true }).first().waitFor();
  await app.evaluate(({ dialog }, pick) => {
    globalThis.__aetherPick = pick;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__aetherPick] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.__aetherPick });
  }, root);
};
const setPick = async (target) => app.evaluate((_electron, pick) => { globalThis.__aetherPick = pick; }, target);
const command = async (text) => {
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search commands, files and actions…").fill(text);
  await page.keyboard.press("Enter");
};
const until = async (condition, label = "condition", attempts = 300) => {
  for (let n = 0; n < attempts; n++) { if (await condition()) return; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(label + " timed out");
};
const draftPath = async () => {
  const base = path.join(profile, "recovery");
  for (const entry of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const owner = await fs.readFile(path.join(base, entry.name, "root.txt"), "utf8").catch(() => null);
    if (owner?.trim() === root || owner?.trim() === newRoot) return path.join(base, entry.name, "draft.json");
  }
  return null;
};
const readDraft = async () => {
  const file = await draftPath();
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
};
const waitDraft = async (marker) => until(async () => (await readDraft())?.context?.files?.[sourceFile]?.includes(marker), "recovery draft");
const waitNoDraft = async () => until(async () => (await readDraft()) === null, "recovery draft cleared");
const editorText = async () => page.locator(".monaco-editor .view-lines").first().innerText();
const waitEditor = async (marker) => { await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 20000 }); await until(async () => (await editorText()).includes(marker), "editor buffer"); };
const edit = async (marker) => {
  await page.getByRole("treeitem", { name: sourceFile, exact: true }).click();
  await page.locator(".monaco-editor .view-lines").first().waitFor();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("// " + marker + "\n");
  await waitDraft(marker);
};
const crash = async () => {
  const child = app.process();
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  app = undefined; page = undefined;
};
const recoveryDialog = () => page.getByRole("dialog").filter({ hasText: "恢复未保存内容" });
const openEditorFile = async () => {
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    await dialog.getByRole("button", { name: "预览 " + sourceFile, exact: true }).click();
  }
};
const stopTestedApp = async () => {
  if (!app) return;
  const child = app.process();
  // Exit only this tested app instance and profile; a native "unsaved changes" dialog must not block the runner.
  try { await app.evaluate(({ app }) => app.exit(0)); } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null && child.signalCode === null) {
    // Own process tree only; no process-name-wide kill.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  }
  app = undefined; page = undefined;
};

let failure = null;
let cleanupFailure = null;
try {
  await launch();
  await command("Open project folder");
  await page.getByText(root, { exact: true }).first().waitFor();
  await page.getByRole("treeitem", { name: sourceFile, exact: true }).waitFor();

  // 1. Dirty buffer survives SIGKILL; the disk file is not auto-saved.
  await edit("crash-restore-marker");
  assert.equal(await fs.readFile(diskPath, "utf8"), original, "autosave must not write the project file");
  await crash();
  assert.ok((await readDraft())?.context.files[sourceFile].includes("crash-restore-marker"), "draft survives the killed process");
  await launch();
  const dialog = recoveryDialog();
  await dialog.waitFor({ timeout: 20000 });
  await dialog.getByText(root, { exact: false }).first().waitFor();
  await dialog.getByRole("button", { name: "预览 " + sourceFile, exact: true }).click();
  await until(async () => (await dialog.locator('[data-recovery-preview="' + sourceFile + '"]').innerText()).includes("crash-restore-marker"), "draft preview");
  assert.ok((await fs.readFile(diskPath, "utf8")) === original, "preview does not write disk");
  await page.screenshot({ path: path.join(results, "recovery-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: "恢复此草稿", exact: true }).click();
  await until(async () => (await page.getByRole("dialog").count()) === 0, "dialog closed after restore");
  await waitEditor("crash-restore-marker");
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  assert.equal(await fs.readFile(diskPath, "utf8"), original, "restore enters the dirty buffer only");
  await page.screenshot({ path: path.join(results, "recovery-restored.png"), fullPage: true });

  // 2. External modification while the restored buffer is dirty still blocks the save.
  let external = original + "// external-after-crash\n";
  await fs.writeFile(diskPath, external);
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+s");
  await page.getByText(/文件已被外部修改：src\/main.cpp/).first().waitFor({ timeout: 20000 });
  assert.equal(await fs.readFile(diskPath, "utf8"), external, "external disk content is preserved");
  await page.getByRole("button", { name: "重新读取（放弃未保存修改）", exact: true }).click();
  await page.getByText("Saved to workspace", { exact: true }).waitFor({ timeout: 20000 });
  await waitNoDraft();
  assert.equal(await fs.readFile(diskPath, "utf8"), external, "reload accepts the disk version");

  // 2b. A disk change during the crash window is kept as a per-file conflict instead of being overwritten.
  await edit("crash-downtime-marker");
  await crash();
  const downtimeDisk = external + "// changed-while-down";
  await fs.writeFile(diskPath, downtimeDisk);
  await launch();
  const downtimeDialog = recoveryDialog();
  await downtimeDialog.waitFor({ timeout: 20000 });
  await recoveredPreview(downtimeDialog, "crash-downtime-marker");
  await downtimeDialog.getByText(/磁盘在草稿写入后已变化：src\/main\.cpp/).waitFor();
  await downtimeDialog.getByRole("button", { name: "恢复此草稿", exact: true }).click();
  await until(async () => (await page.getByRole("dialog").count()) === 0, "dialog closed after downtime restore");
  await waitEditor("crash-downtime-marker");
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+s");
  await page.getByText(/磁盘内容在恢复草稿写入后已发生变化：src\/main\.cpp/).first().waitFor({ timeout: 20000 });
  assert.equal(await fs.readFile(diskPath, "utf8"), downtimeDisk, "downtime disk change is not overwritten");
  await page.getByRole("button", { name: "按文件处理…", exact: true }).click();
  const conflictDialog = page.getByRole("dialog");
  await conflictDialog.getByText("磁盘与缓冲区差异", { exact: true }).waitFor();
  await conflictDialog.getByRole("button", { name: "Keep local and overwrite disk", exact: true }).click();
  await until(async () => (await fs.readFile(diskPath, "utf8")).includes("crash-downtime-marker"), "resolved conflict written");
  await conflictDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+s");
  await page.getByText("Saved to workspace", { exact: true }).waitFor({ timeout: 20000 });
  await waitNoDraft();
  external = await fs.readFile(diskPath, "utf8");

  // 3. Explicit discard after a crash leaves both disk and draft files untouched by recovery.
  await edit("crash-discard-marker");
  assert.equal(await fs.readFile(diskPath, "utf8"), external);
  await crash();
  await launch();
  const discardDialog = recoveryDialog();
  await discardDialog.waitFor({ timeout: 20000 });
  await discardDialog.getByRole("button", { name: "丢弃此草稿", exact: true }).click();
  await waitNoDraft();
  await until(async () => (await page.getByRole("dialog").count()) === 0, "dialog closed after discard");
  assert.equal(await fs.readFile(diskPath, "utf8"), external, "discard never writes the project");
  assert.equal(await page.getByText(/恢复草稿：\d+ 份未处理/).count(), 0, "discarded drafts leave no indicator");

  // 4. "Later" keeps the draft and the project-files plugin can reopen it.
  await edit("crash-later-marker");
  await crash();
  await launch();
  const laterDialog = recoveryDialog();
  await laterDialog.waitFor({ timeout: 20000 });
  await laterDialog.getByRole("button", { name: "稍后处理", exact: true }).click();
  await until(async () => (await page.getByRole("dialog").count()) === 0, "dialog closed for later");
  assert.ok(await readDraft(), "draft is kept for later");
  const indicator = page.getByRole("button", { name: /恢复草稿：1 份未处理/ });
  await indicator.waitFor();
  await indicator.click();
  const reopened = recoveryDialog();
  await reopened.waitFor();
  await recoveredPreview(reopened, "crash-later-marker");
  await reopened.getByRole("button", { name: "丢弃此草稿", exact: true }).click();
  await waitNoDraft();

  // 5. A damaged draft is reported with a readable error, kept for inspection, and never touches source.
  await edit("crash-corrupt-marker");
  await crash();
  const damaged = await draftPath();
  assert.ok(damaged);
  const damagedText = await fs.readFile(damaged, "utf8");
  await fs.writeFile(damaged, damagedText.slice(0, Math.floor(damagedText.length / 2)));
  await launch();
  const brokenDialog = recoveryDialog();
  await brokenDialog.waitFor({ timeout: 20000 });
  await brokenDialog.getByText(/草稿损坏/).first().waitFor();
  await brokenDialog.getByText(/恢复草稿已损坏/).first().waitFor();
  assert.equal(await fs.readFile(diskPath, "utf8"), external, "damaged draft does not change project source");
  await brokenDialog.getByRole("button", { name: "丢弃此草稿", exact: true }).click();
  await waitNoDraft();

  // 6. A project directory deleted while the app was down still offers preview/restore; saving requires a new folder.
  await edit("crash-deleted-marker");
  await crash();
  await fs.rm(root, { recursive: true, force: true });
  await launch();
  const deletedDialog = recoveryDialog();
  await deletedDialog.waitFor({ timeout: 25000 });
  await deletedDialog.getByText(/工程目录已不存在/).first().waitFor();
  await recoveredPreview(deletedDialog, "crash-deleted-marker");
  await deletedDialog.getByRole("button", { name: "恢复此草稿", exact: true }).click();
  await until(async () => (await page.getByRole("dialog").count()) === 0, "dialog closed after deleted-root restore");
  await waitEditor("crash-deleted-marker");
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  await setPick(newRoot);
  await command("Save project to folder");
  await until(async () => !!(await fs.stat(path.join(newRoot, sourceFile)).catch(() => null)), "save as new folder");
  assert.ok((await fs.readFile(path.join(newRoot, sourceFile), "utf8")).includes("crash-deleted-marker"));
  await waitNoDraft();
  await page.getByText("Saved to workspace", { exact: true }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.screenshot({ path: path.join(results, "recovery-deleted-root-saved.png"), fullPage: true });

  assert.deepEqual(errors, [], "no renderer console errors during crash recovery");
  await stopTestedApp();
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(results, "recovery-failure.png"), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(results, "recovery-failure.txt"), error.stack + "\n" + errors.join("\n") + "\n" + await page.locator("body").innerText().catch(() => "")).catch(() => {});
  }
} finally {
  await stopTestedApp();
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Only this test's temporary directory is removed; a cleanup failure fails the run instead of being hidden.
  try { await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); }
  catch (error) { cleanupFailure = error; }
}

async function recoveredPreview(dialog, marker) {
  await dialog.getByRole("button", { name: "预览 " + sourceFile, exact: true }).click();
  await until(async () => (await dialog.locator('[data-recovery-preview="' + sourceFile + '"]').innerText()).includes(marker), "draft preview " + marker);
}

if (failure) {
  console.error(failure.stack ?? String(failure));
  process.exit(1);
}
if (cleanupFailure) {
  console.error("test cleanup failed:", cleanupFailure.message);
  process.exit(1);
}
console.log("PASS crash recovery: real SIGKILL, disk untouched, preview/restore/discard/later, external-modification and downtime-conflict guards, damaged draft isolation, deleted project root and save-as recovery; no hardware");
// Helper handles may outlive an intentionally killed Electron session; every assertion and cleanup above succeeded.
process.exit(0);
