import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-release-'));
const directory = path.join(temp, 'project'); await fs.mkdir(directory); const root = await fs.realpath(directory);
const profile = path.join(temp, 'profile');
await fs.writeFile(path.join(root, 'release.txt'), 'Release launch smoke\n');
const resultsDir = process.env.AETHER_SMOKE_RESULTS ?? 'smoke-results';
await fs.mkdir(resultsDir, { recursive: true });
let app, page; const errors = [];
let unrelated; let unrelatedPid = 0; let ptyChild = 0;
const executable = process.env.AETHER_PACKAGED_EXECUTABLE;
assert.ok(executable, 'AETHER_PACKAGED_EXECUTABLE must point to the packaged app');
const saveKey = process.platform === 'darwin' ? 'Meta+s' : 'Control+s';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error && error.code === 'ESRCH') return false; throw error; } };
const processRows = async () => {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  return stdout.trim().split('\n').map((line) => { const [pid, ppid, ...comm] = line.trim().split(/\s+/); return [Number(pid), Number(ppid), comm.join(' ')]; }).filter(([pid, ppid]) => Number.isFinite(pid) && Number.isFinite(ppid));
};
const foregroundChild = async (parent) => {
  const rows = await processRows();
  const self = rows.find(([pid]) => pid === parent);
  if (self && /sleep/.test(self[2])) return parent;
  return rows.find(([, ppid, comm]) => ppid === parent && /sleep/.test(comm))?.[0] ?? 0;
};
const until = async (test) => { for (let n = 0; n < 200; n++) { if (await test()) return; await new Promise((done) => setTimeout(done, 100)); } throw new Error('Release smoke timed out'); };
const read = (name) => fs.readFile(path.join(root, name), 'utf8');
const viewText = async () => (await page.locator('.monaco-editor .view-lines').allInnerTexts()).join(' ');
const command = async (text) => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByPlaceholder('Search commands, files and actions…').fill(text);
  await page.keyboard.press('Enter');
};
const appendToEditor = async (text) => {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText(text);
};
const closeApp = async () => {
  const child = app.process();
  await Promise.race([app.evaluate(({ app }) => app.exit(0)).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000); } });
  app = undefined;
};
const launch = async () => {
  const env = { ...process.env, AETHER_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: executable, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 45000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  // Only the OS picker result is stubbed; all project I/O uses the real host.
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, root);
};
try {
  await launch();
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('dialog').getByText('本地内置插件 · 16 / 16 已启用', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  await command('Open project folder');
  await page.getByText(root, { exact: true }).first().waitFor();

  // Real disk file and directory creation through the project-files explorer.
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'New file path', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await until(async () => !!(await fs.stat(path.join(root, name)).catch(() => null)));
  }

  // External modification: accepting one file keeps another file's unsaved buffer.
  await page.getByRole('treeitem', { name: 'a.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await appendToEditor('unsaved-local-buffer');
  await fs.writeFile(path.join(root, 'a.txt'), 'external-a\n');
  await page.getByText('目录有外部变更', { exact: true }).waitFor();
  await page.getByRole('button', { name: '按文件处理…', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText('磁盘与缓冲区差异', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: /a\.txt/ }).click();
  await dialog.getByText('磁盘已修改', { exact: true }).first().waitFor();
  await dialog.getByRole('button', { name: 'Use disk version', exact: true }).click();
  await dialog.getByText('磁盘与本地缓冲区一致。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('tab', { name: 'a.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await until(async () => (await viewText()).includes('external-a'));
  await page.getByRole('tab', { name: 'b.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await until(async () => (await viewText()).includes('unsaved-local-buffer'));
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press(saveKey);
  await until(async () => (await read('b.txt')).includes('unsaved-local-buffer'));

  // Reopening the diff after another disk change must show the new text, not a cached model.
  await fs.writeFile(path.join(root, 'a.txt'), 'external-a-again\n');
  await page.getByText('目录有外部变更', { exact: true }).waitFor();
  await page.getByRole('button', { name: '按文件处理…', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('磁盘与缓冲区差异', { exact: true }).waitFor();
  await until(async () => (await viewText()).includes('external-a-again'));
  await dialog.getByRole('button', { name: 'Use disk version', exact: true }).click();
  await dialog.getByText('磁盘与本地缓冲区一致。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  // External addition and deletion are listed and handled per file.
  await fs.writeFile(path.join(root, 'added.txt'), 'disk-added\n');
  await fs.rm(path.join(root, 'c.txt'));
  await page.getByText('目录有外部变更', { exact: true }).waitFor();
  await page.getByRole('button', { name: '按文件处理…', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('磁盘与缓冲区差异', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: /added\.txt/ }).click();
  await dialog.getByText('磁盘新增', { exact: true }).first().waitFor();
  await dialog.getByRole('button', { name: 'Load disk file', exact: true }).click();
  await dialog.getByRole('button', { name: /c\.txt/ }).click();
  await dialog.getByText('磁盘已删除', { exact: true }).first().waitFor();
  await dialog.getByRole('button', { name: 'Accept disk deletion', exact: true }).click();
  await dialog.getByText('磁盘与本地缓冲区一致。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('treeitem', { name: 'added.txt', exact: true }).waitFor();

  // Rename dialog with a dirty buffer: Cancel keeps it, Save and rename writes it.
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await appendToEditor('dirty-rename');
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await fs.stat(path.join(root, 'b.txt')).then(() => true).catch(() => false), true);
  assert.ok((await viewText()).includes('dirty-rename'), 'Cancel keeps the dirty buffer');
  await page.getByRole('treeitem', { name: 'b.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New path', exact: true }).fill('b2.txt');
  await dialog.getByRole('button', { name: 'Save and rename', exact: true }).click();
  await page.getByRole('treeitem', { name: 'b2.txt', exact: true }).waitFor();
  assert.equal(await fs.stat(path.join(root, 'b.txt')).catch(() => null), null);
  await until(async () => (await read('b2.txt')).includes('dirty-rename'));

  // Discard changes and rename keeps the disk content and drops the buffer edit.
  await page.getByRole('treeitem', { name: 'b2.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await appendToEditor('discard-me');
  await page.getByRole('treeitem', { name: 'b2.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New path', exact: true }).fill('b3.txt');
  await dialog.getByRole('button', { name: 'Discard changes and rename', exact: true }).click();
  await page.getByRole('treeitem', { name: 'b3.txt', exact: true }).waitFor();
  assert.equal(await fs.stat(path.join(root, 'b2.txt')).catch(() => null), null);
  assert.equal((await read('b3.txt')).includes('discard-me'), false, 'discard drops the dirty buffer');

  // Dirty delete asks before discarding; Cancel keeps the file, confirm moves it to the system trash.
  await page.getByRole('treeitem', { name: 'b3.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await appendToEditor('delete-discard');
  await page.getByRole('treeitem', { name: 'b3.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await fs.stat(path.join(root, 'b3.txt')).then(() => true).catch(() => false), true);
  await page.getByRole('treeitem', { name: 'b3.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Discard changes and move to Trash', exact: true }).click();
  await until(async () => !(await fs.stat(path.join(root, 'b3.txt')).catch(() => null)));

  // Real directories: create, move through the project tree, and send to the system trash.
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder path', exact: true }).fill('空 目录');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await until(async () => !!(await fs.stat(path.join(root, '空 目录')).catch(() => null)));
  await page.getByRole('treeitem', { name: '空 目录', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New path', exact: true }).fill('重命名 目录');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('treeitem', { name: '重命名 目录', exact: true }).waitFor();
  assert.equal(await fs.stat(path.join(root, '空 目录')).catch(() => null), null);
  await page.getByRole('treeitem', { name: '重命名 目录', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await until(async () => !(await fs.stat(path.join(root, '重命名 目录')).catch(() => null)));
  await page.screenshot({ path: resultsDir + '/release-files.png', fullPage: true });

  // Tool settings persist across a full app restart.
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  let pluginsDialog = page.getByRole('dialog');
  await pluginsDialog.getByRole('button', { name: /^PlatformIO/ }).click();
  const toolField = pluginsDialog.locator('[data-tool-id="platformio"]');
  await toolField.waitFor();
  const toolInput = toolField.getByRole('textbox', { name: 'PlatformIO CLI 可执行文件', exact: true });
  await toolInput.fill(process.execPath);
  await toolInput.press('Enter');
  await until(async () => (await toolInput.inputValue()) === process.execPath);
  await until(async () => JSON.parse(await fs.readFile(path.join(profile, 'tools.json'), 'utf8').catch(() => '{}')).paths?.platformio === process.execPath);
  await pluginsDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  // Every buffer was saved or discarded above; a clean exit must not autosave a recovery draft.
  assert.equal(await page.getByText('Saved to workspace', { exact: true }).count(), 1, 'no unsaved edits before the restart');
  await closeApp();
  await launch();
  await page.getByText(root, { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('dialog').filter({ hasText: '恢复未保存内容' }).count(), 0, 'a clean restart must not show a recovery draft');
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  pluginsDialog = page.getByRole('dialog');
  await pluginsDialog.getByRole('button', { name: /^PlatformIO/ }).click();
  const restoredTool = pluginsDialog.locator('[data-tool-id="platformio"]');
  await restoredTool.waitFor();
  const restoredInput = restoredTool.getByRole('textbox', { name: 'PlatformIO CLI 可执行文件', exact: true });
  await until(async () => (await restoredInput.inputValue()) === process.execPath);
  assert.equal(await restoredInput.inputValue(), process.execPath, 'tool path survives an app restart');
  await pluginsDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  if (unrelated.pid === undefined) await new Promise((resolve, reject) => { unrelated.once('spawn', resolve); unrelated.once('error', reject); });
  unrelatedPid = unrelated.pid;
  await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
  await page.locator('[data-terminal-status="running"]').waitFor();
  const session = await page.evaluate(() => window.aether.terminal.get()); assert.equal(session.root, root);
  await page.evaluate(({ id, windows }) => window.aether.terminal.write(id, windows ? 'echo RELEASE_PTY_OK> native-pty.txt\r' : "printf RELEASE_PTY_OK > native-pty.txt\r"), { id: session.id, windows: process.platform === 'win32' });
  await until(async () => (await fs.readFile(path.join(root, 'native-pty.txt'), 'utf8').catch(() => '')).trim() === 'RELEASE_PTY_OK');
  if (process.platform !== 'win32') {
    await page.evaluate(({ id }) => window.aether.terminal.write(id, 'sleep 300\r'), { id: session.id });
    await until(async () => (ptyChild = await foregroundChild(session.pid)) > 0);
  }
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await page.locator('[data-terminal-status="stopped"]').waitFor();
  if (ptyChild) await until(() => !alive(ptyChild));
  assert.ok(alive(unrelatedPid), 'unrelated process survives terminal stop');

  // Save dirty buffers through the normal path (a refused save must fail) before switching projects.
  await page.locator('nav').getByRole('button', { name: 'Source Code', exact: true }).click();
  await page.getByRole('treeitem', { name: 'a.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press(saveKey);
  await until(async () => (await page.getByText('Unsaved changes', { exact: true }).count()) === 0);

  // The same file name in another project previews that project's content, not a cached model.
  const second = path.join(temp, 'second-project'); await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(second, 'a.txt'), 'second-project-buffer\n');
  const secondRoot = await fs.realpath(second);
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, secondRoot);
  await page.locator('nav').getByRole('button', { name: 'Build Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Open project folder', exact: true }).click();
  await page.getByText(secondRoot, { exact: true }).first().waitFor();
  await fs.writeFile(path.join(secondRoot, 'a.txt'), 'second-project-external\n');
  await page.getByText('目录有外部变更', { exact: true }).waitFor();
  await page.getByRole('button', { name: '按文件处理…', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('磁盘与缓冲区差异', { exact: true }).waitFor();
  await until(async () => (await viewText()).includes('second-project-external'));
  assert.equal((await viewText()).includes('external-a-again'), false, 'another project does not reuse the same-named file preview');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({ path: resultsDir + '/release-cross-project.png', fullPage: true });
  await page.screenshot({ path: resultsDir + '/release-' + process.platform + '-' + process.arch + '.png', fullPage: true });
  assert.deepEqual(errors, [], 'no renderer console errors');
  const version = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(version, JSON.parse(await fs.readFile('package.json', 'utf8')).version);
  await closeApp();
  if (process.platform === 'darwin') {
    const appBundle = path.resolve(executable, '../../..');
    await promisify(execFile)('codesign', ['--verify', '--deep', '--strict', appBundle]);
  }
  console.log(`PASS packaged ${process.platform}/${process.arch}: v${version}, 16 plugins, isolated renderer, actual project picker I/O, real file create/rename/trash, external add/modify/delete review kept another unsaved buffer, dirty rename save/cancel/discard, dirty delete confirmation, directory trash, tool path survived restart, native PTY write and shutdown`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: resultsDir + '/release-failure.png', fullPage: true }); await fs.writeFile(resultsDir + '/release-failure.txt', String(error.stack) + '\n' + errors.join('\n') + '\n' + await page.locator('body').innerText()); }
  throw error;
} finally {
  if (app) {
    const child = app.process();
    if (process.platform === 'win32' && child.pid && child.exitCode === null) { try { await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch {} }
    else if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000); } });
  }
  try { if (unrelatedPid && alive(unrelatedPid)) unrelated.kill('SIGKILL'); } catch {}
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 });
}
