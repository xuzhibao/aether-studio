import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startWebSocketPeer } from './websocket-peer.mjs';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-electron-'));
const root = path.join(temp, 'project'); const profile = path.join(temp, 'profile');
await fs.mkdir(root); await fs.mkdir(profile);
await fs.cp('examples/platformio-native', root, { recursive: true, filter: (source) => !source.split(path.sep).includes('.pio') });
await fs.mkdir('smoke-results', { recursive: true });
const portable = path.join(temp, 'export.aether');
let app, page, peer, serialPeer;
const errors = [];
const env = { ...process.env, AETHER_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
const launch = async () => {
  app = await electron.launch({ ...(process.env.AETHER_PACKAGED_EXECUTABLE ? { executablePath: process.env.AETHER_PACKAGED_EXECUTABLE, args: ['--no-sandbox'] } : { args: ['.', '--no-sandbox'] }), env, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('button', { name: 'Plugins', exact: true }).first().waitFor();
  await app.evaluate(({ dialog }, { root, portable }) => {
    // Only the OS picker result is stubbed. All project and bundle I/O uses the real host.
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? root : portable] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: portable });
  }, { root, portable });
};
const command = async (text) => {
  await page.keyboard.press('Control+k'); await page.getByPlaceholder('Search commands, files and actions…').fill(text); await page.keyboard.press('Enter');
};
const until = async (condition) => { for (let n = 0; n < 300; n++) { if (await condition()) return; await new Promise((done) => setTimeout(done, 100)); } throw new Error('Condition timed out'); };
const read = (name) => fs.readFile(path.join(root, name), 'utf8');
try {
  await launch();
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await command('Open project folder');
  await page.getByText(root, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Source Code', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await page.locator('.monaco-editor .view-lines').first().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n// edited in Electron\n'); await page.keyboard.press('Control+s');
  await until(async () => (await read('src/main.cpp')).includes('// edited in Electron'));
  await page.keyboard.press('Control+Shift+e'); await until(async () => !!(await fs.stat(portable).catch(() => null)));
  assert.ok(JSON.parse(await fs.readFile(portable, 'utf8')).workspace.files['src/main.cpp'].includes('// edited in Electron'));
  await page.keyboard.press('Control+Shift+o'); await until(async () => !await page.getByText(root, { exact: true }).count());
  await command('Open project folder'); await page.getByText(root, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Source Code', exact: true }).click();
  const before = await read('src/main.cpp'); await fs.writeFile(path.join(root, 'src/main.cpp'), before + '// external version\n');
  await page.getByText('目录有外部变更', { exact: true }).waitFor();
  await page.locator('.monaco-editor .view-lines').first().click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n// conflicting buffer\n'); await page.keyboard.press('Control+s');
  await page.getByText(/文件已被外部修改：src\/main.cpp/).first().waitFor();
  assert.equal(await read('src/main.cpp'), before + '// external version\n');
  await page.getByRole('button', { name: '重新读取（放弃未保存修改）', exact: true }).click();
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByRole('textbox', { name: 'File path', exact: true }).fill('src/extra.h');
  await page.getByRole('button', { name: 'Create file', exact: true }).click(); await page.keyboard.press('Control+s');
  await until(async () => !!(await fs.stat(path.join(root, 'src/extra.h')).catch(() => null)));
  await page.getByRole('button', { name: 'Build Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Build with PlatformIO', exact: true }).click();
  await page.locator('[data-task-status="succeeded"]').waitFor({ timeout: 180000 });
  const build = JSON.parse(await read('.aether/build.json')); assert.ok(build.artifacts.some((artifact) => /\/program(\.exe)?$/.test(artifact.path)));
  await page.screenshot({ path: 'smoke-results/electron-build.png', fullPage: true });
  await fs.writeFile(path.join(root, 'src/main.cpp'), 'invalid C++ syntax !\n');
  await page.getByRole('button', { name: '重新读取（放弃未保存修改）', exact: true }).click();
  await page.getByRole('button', { name: 'Build Tasks', exact: true }).click(); await page.getByRole('button', { name: 'Build with PlatformIO', exact: true }).click();
  await page.locator('[data-task-status="failed"]').waitFor({ timeout: 60000 });
  await fs.appendFile(path.join(root, 'platformio.ini'), '\nextra_scripts = pre:slow.py\n');
  await fs.writeFile(path.join(root, 'slow.py'), 'import time\nprint("fixture slow build", flush=True)\ntime.sleep(30)\n');
  await page.getByRole('button', { name: '重新读取（放弃未保存修改）', exact: true }).click();
  await page.getByRole('button', { name: 'Build Tasks', exact: true }).click(); await page.getByRole('button', { name: 'Build with PlatformIO', exact: true }).click();
  await page.getByText(/fixture slow build/).first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click(); await page.locator('[data-task-status="cancelled"]').waitFor();
  await page.screenshot({ path: 'smoke-results/electron-task-results.png', fullPage: true });
  // Actual OS PTY, through the migrated Electron serial backend and monitor UI.
  await fs.rm('smoke-results/serial-port.txt', { force: true });
  serialPeer = spawn('python3', ['scripts/serial-peer.py'], { stdio: 'pipe' });
  await until(async () => !!(await fs.stat('smoke-results/serial-port.txt').catch(() => null)));
  const port = (await fs.readFile('smoke-results/serial-port.txt', 'utf8')).trim();
  await page.locator('nav').getByRole('button', { name: 'Devices', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByRole('textbox', { name: '端口路径', exact: true }).fill(port); await dialog.getByRole('button', { name: '建立连接', exact: true }).click();
  await dialog.getByText(new RegExp('已连接 ' + port)).waitFor(); await dialog.getByRole('button', { name: '打开 Serial Monitor', exact: true }).click();
  await page.getByRole('textbox', { name: 'Serial text', exact: true }).fill('smoke-native-serial'); await page.getByRole('textbox', { name: 'Serial text', exact: true }).press('Enter');
  await page.getByText('RX · PTY fixture RX: acknowledgement', { exact: true }).waitFor();
  await page.screenshot({ path: 'smoke-results/electron-serial.png', fullPage: true });
  await page.getByRole('button', { name: 'Manage connection', exact: true }).click(); await dialog.getByRole('button', { name: '断开连接', exact: true }).click();
  await dialog.getByText('未建立连接', { exact: true }).waitFor();
  peer = await startWebSocketPeer();
  await dialog.getByRole('combobox', { name: '通信插件', exact: true }).selectOption('websocket'); await dialog.getByRole('textbox', { name: 'WebSocket URL', exact: true }).fill(peer.url); await dialog.getByRole('button', { name: '建立连接', exact: true }).click(); await dialog.getByText(/^已连接 ws:/).waitFor();
  await dialog.getByRole('button', { name: '打开 Serial Monitor', exact: true }).click(); await page.getByRole('textbox', { name: 'Serial text', exact: true }).fill('真实网络检查'); await page.getByRole('textbox', { name: 'Serial text', exact: true }).press('Enter');
  await page.getByText('RX · WebSocket fixture binary: 真实网络检查', { exact: true }).waitFor(); assert.equal(peer.received[0].binary, true);
  await page.screenshot({ path: 'smoke-results/electron-websocket.png', fullPage: true });
  await command('Disconnect device transport');
  assert.deepEqual(errors, [], 'no renderer console errors');
  await app.close(); app = undefined;
  await launch(); await page.getByText(root, { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => window.aether.runtime), 'electron');
  await app.close(); app = undefined;
  console.log('PASS Electron: isolated preload, real disk folder open/edit/save/reopen, portable files, external edit refusal, new file, real PlatformIO build/failure/cancel, OS PTY and WebSocket UI round trips; picker selection fixture only, no hardware');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'smoke-results/electron-failure.png', fullPage: true }); await fs.writeFile('smoke-results/electron-failure.txt', error.stack + '\n' + errors.join('\n') + '\n' + await page.locator('body').innerText()); }
  throw error;
} finally {
  if (app) app.process().kill('SIGKILL');
  serialPeer?.kill(); await peer?.close(); await fs.rm(temp, { recursive: true, force: true });
}
