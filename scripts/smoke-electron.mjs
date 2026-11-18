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
await fs.writeFile(path.join(root, 'src/helper.hpp'), '#pragma once\ninline int sensor_value(int input) { return input + 1; }\n');
// A native PlatformIO upload runs the built program, so a nonzero program exit gives a real failed upload without hardware.
const deployRoot = path.join(temp, 'deploy-project');
await fs.cp('examples/platformio-native', deployRoot, { recursive: true, filter: (source) => !source.split(path.sep).includes('.pio') });
await fs.writeFile(path.join(deployRoot, 'src/main.cpp'), '#include <cstdio>\n#include <chrono>\n#include <thread>\nint main() { std::puts("fixture upload start"); std::this_thread::sleep_for(std::chrono::seconds(8)); std::puts("fixture upload exit 7"); return 7; }\n');
// A real ESP build whose read-only device check runs against an absent port: the UI must show the block and start no write.
const espRoot = path.join(temp, 'esp-project');
await fs.cp('examples/platformio-esp32s3', espRoot, { recursive: true, filter: (source) => !source.split(path.sep).includes('.pio') });
const portable = path.join(temp, 'export.aether');
// File-backed fake esptool for the Flash panel: a POSIX wrapper runs the existing fixture; no serial port or board is touched.
const flashImage = path.join(temp, 'flash-image.bin');
const flashBytes = Buffer.alloc(1024 * 1024);
for (let index = 0; index < flashBytes.length; index++) flashBytes[index] = (index * 31 + 7) & 0xff;
flashBytes[0] = 0xe9; flashBytes[0x8000] = 0xaa; flashBytes[0x8001] = 0x50;
await fs.writeFile(flashImage, flashBytes);
const flashTool = path.join(temp, 'fake-esptool');
await fs.writeFile(flashTool, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('scripts/fixtures/fake-esptool.mjs'))} "$@"\n`);
await fs.chmod(flashTool, 0o755);
const flashOutput = path.join(temp, 'flash-backup.bin');
let app, page, peer, serialPeer;
const errors = [];
const env = { ...process.env, AETHER_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
if (process.platform !== 'win32') Object.assign(env, { AETHER_FAKE_IMAGE: flashImage, AETHER_FAKE_STATE: path.join(temp, 'flash-state.json'), AETHER_FAKE_LOG: path.join(temp, 'flash-calls.log'), AETHER_FAKE_FLASH: '1MB', AETHER_FAKE_DELAY_MS: '1500' });
const launch = async () => {
  app = await electron.launch({ ...(process.env.AETHER_PACKAGED_EXECUTABLE ? { executablePath: process.env.AETHER_PACKAGED_EXECUTABLE, args: ['--no-sandbox'] } : { args: ['.', '--no-sandbox'] }), env, timeout: 30000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push('pageerror: ' + (error.stack ?? error.message)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push('console.error: ' + message.text() + ' @ ' + JSON.stringify(message.location())); });
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
  // Real disk create/rename/trash through the project-files plugin explorer.
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  let filesDialog = page.getByRole('dialog');
  await filesDialog.getByRole('textbox', { name: 'New folder path', exact: true }).fill('空 目录');
  await filesDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await until(async () => !!(await fs.stat(path.join(root, '空 目录')).catch(() => null)));
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  filesDialog = page.getByRole('dialog');
  await filesDialog.getByRole('textbox', { name: 'New file path', exact: true }).fill('空 目录/说明 文档.txt');
  await filesDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await until(async () => !!(await fs.stat(path.join(root, '空 目录/说明 文档.txt')).catch(() => null)));
  await page.getByRole('treeitem', { name: '空 目录/说明 文档.txt', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.insertText('中文与空格路径\n');
  await page.keyboard.press('Control+s');
  await until(async () => (await read('空 目录/说明 文档.txt')).trim() === '中文与空格路径');
  await page.getByRole('treeitem', { name: '空 目录/说明 文档.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  filesDialog = page.getByRole('dialog');
  await filesDialog.getByRole('textbox', { name: 'New path', exact: true }).fill('空 目录/新 名字.txt');
  await filesDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await until(async () => !!(await fs.stat(path.join(root, '空 目录/新 名字.txt')).catch(() => null)));
  assert.equal(await fs.stat(path.join(root, '空 目录/说明 文档.txt')).catch(() => null), null);
  await page.getByRole('treeitem', { name: '空 目录', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  filesDialog = page.getByRole('dialog');
  await filesDialog.getByRole('textbox', { name: 'New path', exact: true }).fill('重命名 目录');
  await filesDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await until(async () => !!(await fs.stat(path.join(root, '重命名 目录/新 名字.txt')).catch(() => null)));
  assert.equal(await fs.stat(path.join(root, '空 目录')).catch(() => null), null);
  await page.getByRole('treeitem', { name: '重命名 目录/新 名字.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  filesDialog = page.getByRole('dialog');
  await filesDialog.getByRole('button', { name: 'Move to Trash', exact: true }).click();
  await until(async () => !(await fs.stat(path.join(root, '重命名 目录/新 名字.txt')).catch(() => null)));
  assert.equal(await page.getByRole('treeitem', { name: '重命名 目录/新 名字.txt', exact: true }).count(), 0);
  await page.screenshot({ path: 'smoke-results/electron-project-files.png', fullPage: true });
  await page.getByRole('button', { name: 'Source Code', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').first().waitFor();
  const replaceCode = async (text) => { await page.locator('.monaco-editor .view-lines').first().click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(text); };
  const originalCode = await read('src/main.cpp');
  const workingCode = '#include "helper.hpp"\nint main() { return sensor_value(3); }\n';
  await replaceCode('#include "helper.hpp"\nint main() { return does_not_exist; }\n');
  await until(async () => (await page.evaluate(() => window.aether.language.get()))?.documents.some((doc) => doc.file === 'src/main.cpp' && doc.diagnostics.some((item) => item.severity === 1)));
  await page.locator('.monaco-editor .squiggly-error').first().waitFor();
  assert.equal(await read('src/main.cpp'), originalCode, 'language diagnostics must use the unsaved buffer');
  await page.getByRole('button', { name: 'C/C++ Language', exact: true }).click();
  await page.getByText(/use of undeclared identifier 'does_not_exist'/i).first().waitFor();
  await page.getByRole('button', { name: /src\/main.cpp:2:/ }).click();
  await replaceCode('#include "helper.hpp"\nint main() { return sensor_v; }\n');
  await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Space');
  await page.locator('.suggest-widget').getByText(/sensor_value/).first().waitFor();
  await page.keyboard.press('Escape');
  await replaceCode(workingCode);
  await page.locator('.monaco-editor .view-line').filter({ hasText: 'sensor_value' }).getByText('sensor_value', { exact: true }).click();
  await page.keyboard.press('F12');
  await page.getByRole('tab', { name: 'helper.hpp', exact: true }).waitFor();
  await page.locator('[data-code-preview="src/helper.hpp"]').waitFor();
  await page.screenshot({ path: 'smoke-results/electron-language-definition.png', fullPage: true });
  await page.getByRole('tab', { name: 'main.cpp', exact: true }).click();
  await replaceCode(originalCode); await page.keyboard.press('Control+s');
  await until(async () => await read('src/main.cpp') === originalCode);
  await page.getByRole('button', { name: 'Build Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Generate compilation database', exact: true }).click();
  await page.locator('[data-task-provider="platformio.compiledb"] [data-task-status="succeeded"]').waitFor({ timeout: 180000 });
  assert.ok(JSON.parse(await read('compile_commands.json')).some((item) => item.file.endsWith('main.cpp')));
  await page.getByRole('button', { name: 'C/C++ Language', exact: true }).click();
  await page.getByRole('button', { name: 'Restart clangd', exact: true }).click();
  await page.locator('[data-language-status="ready"]').waitFor();
  await page.locator('[data-language-database="ready"]').waitFor();
  await page.getByText(/已就绪（使用根目录 compile_commands.json）/).first().waitFor();
  await page.getByRole('tab', { name: 'main.cpp', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.aether.language.get()))?.documents.some((doc) => doc.file === 'src/main.cpp'));
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  let pluginDialog = page.getByRole('dialog');
  // Plugin-owned tool settings: actual status probe, saved executable and user-data persistence.
  await pluginDialog.getByRole('button', { name: /^PlatformIO/ }).click();
  const platformioField = pluginDialog.locator('[data-tool-id="platformio"]');
  await platformioField.waitFor();
  await until(async () => (await platformioField.getAttribute('data-tool-available')) !== 'unknown');
  assert.equal(await platformioField.getAttribute('data-tool-available'), 'true', await platformioField.innerText());
  await platformioField.getByRole('button', { name: /检测/ }).click();
  await platformioField.getByText(/PlatformIO Core/).first().waitFor();
  if (process.env.AETHER_PLATFORMIO_CLI) {
    const toolInput = platformioField.getByRole('textbox', { name: 'PlatformIO CLI 可执行文件', exact: true });
    await toolInput.fill(process.env.AETHER_PLATFORMIO_CLI);
    await toolInput.press('Enter');
    await until(async () => JSON.parse(await fs.readFile(path.join(profile, 'tools.json'), 'utf8').catch(() => '{}')).paths?.platformio === process.env.AETHER_PLATFORMIO_CLI);
    assert.equal(await toolInput.inputValue(), process.env.AETHER_PLATFORMIO_CLI);
  }
  await pluginDialog.getByRole('button', { name: /^C\/C\+\+ · clangd/ }).click();
  await pluginDialog.getByRole('button', { name: '停用', exact: true }).click();
  let languageAfterDisable = null;
  for (let n = 0; n < 300; n++) {
    languageAfterDisable = await page.evaluate(() => window.aether.language.get());
    if (languageAfterDisable === null) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(languageAfterDisable, null, 'disabling the plugin must stop the language session: ' + JSON.stringify(languageAfterDisable));
  assert.equal(await page.locator('nav').getByRole('button', { name: 'C/C++ Language', exact: true }).count(), 0);
  await pluginDialog.getByRole('button', { name: '启用', exact: true }).click();
  await pluginDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.aether.language.get()))?.documents.some((doc) => doc.file === 'src/main.cpp'));
  await page.screenshot({ path: 'smoke-results/electron-language-reenabled.png', fullPage: true });
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
  await page.getByRole('textbox', { name: 'New file path', exact: true }).fill('src/extra.h');
  await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.keyboard.press('Control+s');
  await until(async () => !!(await fs.stat(path.join(root, 'src/extra.h')).catch(() => null)));
  await page.getByRole('button', { name: 'Build Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Build with PlatformIO', exact: true }).click();
  await page.locator('[data-task-provider="platformio.build"] [data-task-status="succeeded"]').waitFor({ timeout: 180000 });
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
  // A running task owns the native port: the Devices dialog must not open a competing serial session.
  await page.locator('nav').getByRole('button', { name: 'Devices', exact: true }).click();
  const guardDialog = page.getByRole('dialog');
  await guardDialog.getByRole('combobox', { name: '通信插件', exact: true }).selectOption('native-serial');
  await guardDialog.getByText('构建或上传任务正在运行，暂时不能连接原生串口。', { exact: true }).waitFor();
  assert.equal(await guardDialog.getByRole('button', { name: '建立连接', exact: true }).isDisabled(), true);
  // Public Modal at 1280x720: the title/close row must stay pinned in the viewport while the body scrolls.
  const baseViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1280, height: 720 });
  const closeVisible = async (width, height) => {
    const box = await guardDialog.getByRole('button', { name: 'Close dialog', exact: true }).boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `Close must stay inside the ${width}x${height} viewport: ` + JSON.stringify(box));
    return box;
  };
  await closeVisible(1280, 720);
  const scrolled = await guardDialog.evaluate((element) => {
    const nodes = [element, ...element.querySelectorAll('*')];
    const scroller = nodes.find((node) => node.scrollHeight > node.clientHeight + 4 && getComputedStyle(node).overflowY === 'auto');
    if (!scroller) return null;
    scroller.scrollTop = scroller.scrollHeight;
    return { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop };
  });
  if (scrolled) {
    assert.ok(scrolled.scrollTop > 0, 'the dialog body must scroll when its content is taller than the window: ' + JSON.stringify(scrolled));
    await closeVisible(1280, 720);
  }
  await page.setViewportSize({ width: 860, height: 620 });
  await closeVisible(860, 620);
  await guardDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(async () => (await page.getByRole('dialog').count()) === 0);
  await page.setViewportSize(baseViewport);
  await page.locator('nav').getByRole('button', { name: 'Build Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click(); await page.locator('[data-task-status="cancelled"]').waitFor();
  await page.screenshot({ path: 'smoke-results/electron-task-results.png', fullPage: true });
  // Real PlatformIO upload failure (program exits 7), then retry after correcting the port must start a new task with COM_B.
  await app.evaluate(({ dialog }, { folder, portable }) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : portable] });
  }, { folder: deployRoot, portable });
  await command('Open project folder'); await page.getByText(deployRoot, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Deploy to Device', exact: true }).click();
  let deployDialog = page.getByRole('dialog'); const deployCard = page.locator('[data-deploy-task]');
  await deployDialog.getByLabel('Upload port', { exact: true }).fill('COM_C');
  await deployDialog.getByRole('button', { name: '开始构建并烧录', exact: true }).click();
  // The upload fixture sleeps before exiting, so the running task can be cancelled from the Deploy dialog.
  await page.locator('[data-deploy-status="running"]').waitFor({ timeout: 240000 });
  await deployDialog.getByRole('button', { name: '取消上传', exact: true }).click();
  await page.locator('[data-deploy-status="cancelled"]').waitFor({ timeout: 60000 });
  assert.equal(await deployCard.getAttribute('data-deploy-port'), 'COM_C');
  const cancelledDeploy = await deployCard.getAttribute('data-deploy-task');
  await deployDialog.getByLabel('Upload port', { exact: true }).fill('COM_A');
  await deployDialog.getByRole('button', { name: '重试上传', exact: true }).click();
  await until(async () => (await deployCard.getAttribute('data-deploy-task')) !== cancelledDeploy);
  await page.locator('[data-deploy-status="failed"]').waitFor({ timeout: 240000 });
  const firstDeploy = await deployCard.getAttribute('data-deploy-task');
  assert.equal(await deployCard.getAttribute('data-deploy-port'), 'COM_A');
  assert.match(await deployCard.innerText(), /exit 1/);
  assert.match(await deployCard.innerText(), /fixture upload exit 7/);
  await deployDialog.getByLabel('Upload port', { exact: true }).fill('COM_B');
  await deployDialog.getByRole('button', { name: '重试上传', exact: true }).click();
  await until(async () => (await deployCard.getAttribute('data-deploy-task')) !== firstDeploy);
  assert.equal(await deployCard.getAttribute('data-deploy-port'), 'COM_B');
  await page.locator('[data-deploy-status="failed"]').waitFor({ timeout: 240000 });
  assert.match(await deployCard.innerText(), /exit 1/);
  await page.screenshot({ path: 'smoke-results/electron-deploy-failure.png', fullPage: true });
  // Deploy cards and preflight findings make this dialog tall; the pinned close button must still be clickable.
  await deployDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(async () => (await page.getByRole('dialog').count()) === 0);
  // Deploy preflight UI: a real ESP32-S3 build plus a read-only esptool check on a port that does not exist.
  // The dialog must show the block, offer no write, and stay retryable after the user corrects the port.
  await app.evaluate(({ dialog }, { folder, portable }) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : portable] });
  }, { folder: espRoot, portable });
  await command('Open project folder'); await page.getByText(espRoot, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Deploy to Device', exact: true }).click();
  const espDeployDialog = page.getByRole('dialog');
  await espDeployDialog.getByLabel('Upload port', { exact: true }).fill('COM_SMOKE_ABSENT');
  await espDeployDialog.getByRole('button', { name: '开始构建并烧录', exact: true }).click();
  const espBlocked = espDeployDialog.locator('[data-esp-preflight="blocked"]');
  await espBlocked.waitFor({ timeout: 300000 });
  await espBlocked.getByText('已阻止写入', { exact: true }).waitFor();
  await espBlocked.locator('[data-severity="block"]').first().waitFor();
  await espBlocked.getByText(/下一步：/).first().waitFor();
  assert.equal(await espDeployDialog.locator('[data-deploy-task]').count(), 0, 'a blocked preflight must not start a write task');
  await espDeployDialog.getByRole('alert').filter({ hasText: '部署前核对未通过' }).waitFor();
  assert.equal(await espDeployDialog.getByRole('button', { name: '开始构建并烧录', exact: true }).isDisabled(), false, 'a blocked preflight stays retryable after the port is corrected');
  await page.screenshot({ path: 'smoke-results/electron-deploy-preflight-blocked.png', fullPage: true });
  await espDeployDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(async () => (await page.getByRole('dialog').count()) === 0);
  // The previous project's upload result must not appear in this project's deploy dialog.
  await app.evaluate(({ dialog }, { folder, portable }) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : portable] });
  }, { folder: root, portable });
  await command('Open project folder'); await page.getByText(root, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Deploy to Device', exact: true }).click();
  deployDialog = page.getByRole('dialog');
  assert.equal(await deployDialog.locator('[data-deploy-task]').count(), 0, 'another project upload result is not shown');
  // The ESP preflight card from the previous project can still be tall; the pinned header keeps Close reachable.
  await deployDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await until(async () => (await page.getByRole('dialog').count()) === 0);
  // Actual OS PTY, through the migrated Electron serial backend and monitor UI.
  await fs.rm('smoke-results/serial-port.txt', { force: true });
  serialPeer = spawn('python3', ['scripts/serial-peer.py'], { stdio: 'pipe' });
  await until(async () => !!(await fs.stat('smoke-results/serial-port.txt').catch(() => null)));
  const port = (await fs.readFile('smoke-results/serial-port.txt', 'utf8')).trim();
  await page.locator('nav').getByRole('button', { name: 'Devices', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByLabel('端口路径', { exact: true }).fill(port); await dialog.getByRole('button', { name: '建立连接', exact: true }).click();
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
  // Flash panel through the real UI: navigation from the command palette, a real esptool CLI surface backed by
  // the file fixture, cancellation, and the port-ownership guard while a backup runs. Only OS port enumeration is stubbed.
  if (process.platform !== 'win32') {
    await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
    const flashPluginDialog = page.getByRole('dialog');
    await flashPluginDialog.getByRole('button').filter({ hasText: 'ESP Flash 备份/恢复' }).click();
    const flashToolInput = flashPluginDialog.getByRole('textbox', { name: 'esptool 可执行文件', exact: true });
    await flashToolInput.fill(flashTool); await flashToolInput.press('Enter');
    await until(async () => JSON.parse(await fs.readFile(path.join(profile, 'tools.json'), 'utf8').catch(() => '{}')).paths?.esptool === flashTool);
    await flashPluginDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await until(async () => (await page.getByRole('dialog').count()) === 0);
    await app.evaluate(({ ipcMain }) => {
      // Only the OS port list is stubbed; the Flash service and esptool fixture still run for real.
      ipcMain.removeHandler('serial:list');
      ipcMain.handle('serial:list', () => [{ path: 'COM_SMOKE_FLASH', label: 'Smoke flash fixture', detail: 'VID:PID 303A:1001' }]);
    });
    await command('打开 ESP Flash 备份/恢复');
    await page.getByRole('heading', { name: 'ESP Flash 备份 / 恢复', exact: true }).waitFor();
    await page.getByLabel('端口', { exact: true }).selectOption('COM_SMOKE_FLASH');
    await page.getByRole('button', { name: '读取设备信息', exact: true }).click();
    await page.getByText(/已读取 ESP32-C3/).waitFor({ timeout: 30000 });
    await page.getByLabel('块大小', { exact: true }).selectOption('256');
    await page.getByLabel('每块重试', { exact: true }).selectOption('0');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, flashOutput);
    await page.getByRole('button', { name: '选择保存位置', exact: true }).click();
    await page.getByText(flashOutput, { exact: true }).waitFor();
    await page.getByRole('button', { name: '开始备份', exact: true }).click();
    await page.getByText('备份中', { exact: true }).waitFor();
    await page.locator('nav').getByRole('button', { name: 'Devices', exact: true }).click();
    const flashGuardDialog = page.getByRole('dialog');
    await flashGuardDialog.getByText('Flash 备份/恢复正在进行，暂时不能连接原生串口。', { exact: true }).waitFor();
    assert.equal(await flashGuardDialog.getByRole('button', { name: '建立连接', exact: true }).isDisabled(), true, 'a running flash operation owns the port');
    await flashGuardDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await until(async () => (await page.getByRole('dialog').count()) === 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText(/备份已取消/).waitFor({ timeout: 30000 });
    assert.equal(await fs.stat(flashOutput).then(() => true, () => false), false, 'a cancelled backup must not publish a file');
    await page.getByText('空闲', { exact: true }).waitFor();
    await page.screenshot({ path: 'smoke-results/electron-flash-cancelled.png', fullPage: true });
  }
  // Actual interactive PTY terminal, rendered by the terminal plugin.
  const terminalText = async () => await page.locator('.xterm-accessibility-tree').textContent() ?? '';
  const terminalCommand = async (text) => { const input = page.getByRole('textbox', { name: 'Terminal input', exact: true }); await input.focus(); await input.evaluate((element, value) => { const data = new DataTransfer(); data.setData('text/plain', value); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, text); await page.keyboard.press('Enter'); };
  const processGone = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
  await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
  await page.locator('[data-terminal-status="running"]').waitFor();
  const terminalSession = await page.evaluate(() => window.aether.terminal.get());
  await terminalCommand('printf "GUI_PTY:%s:%s\\n" "$PWD" "$(test -t 0 && printf yes)"');
  await until(async () => (await terminalText()).includes('GUI_PTY:' + root + ':yes'));
  await terminalCommand("printf 'GUI_UNI:%s\\n' '真实终端'");
  await until(async () => (await terminalText()).includes('GUI_UNI:真实终端'));
  await terminalCommand("printf from-terminal-ui > terminal-ui.txt; retained_token=kept");
  await until(async () => await read('terminal-ui.txt').catch(() => '') === 'from-terminal-ui');
  await page.getByRole('textbox', { name: 'Terminal input', exact: true }).focus();
  await page.keyboard.type('will_be_killed'); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+k');
  assert.equal(await page.getByPlaceholder('Search commands, files and actions…').count(), 0, 'terminal owns Ctrl+K');
  await page.keyboard.type("printf 'KEYS:%s\\n' ok"); await page.keyboard.press('Enter');
  await until(async () => (await terminalText()).includes('KEYS:ok'));
  await page.locator('nav').getByRole('button', { name: 'Build Tasks', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.equal((await page.evaluate(() => window.aether.terminal.get())).pid, terminalSession.pid);
  await terminalCommand('printf "KEEP:%s\\n" "$retained_token"'); await until(async () => (await terminalText()).includes('KEEP:kept'));
  const originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 1500, height: 950 });
  await until(async () => (await page.evaluate(() => window.aether.terminal.get())).cols !== terminalSession.cols);
  const dimensions = await page.evaluate(() => window.aether.terminal.get());
  await terminalCommand('printf "GUI_SIZE:%s\\n" "$(stty size)"');
  await until(async () => (await terminalText()).includes('GUI_SIZE:' + dimensions.rows + ' ' + dimensions.cols));
  await terminalCommand("sh -c 'echo $$ > terminal-foreground.pid; exec sleep 30'");
  await until(async () => !!(await fs.stat(path.join(root, 'terminal-foreground.pid')).catch(() => null)));
  const interruptedPid = Number(await read('terminal-foreground.pid'));
  await page.getByRole('textbox', { name: 'Terminal input', exact: true }).focus(); await page.keyboard.press('Control+c');
  await terminalCommand("printf 'RESUMED:%s\\n' yes"); await until(async () => (await terminalText()).includes('RESUMED:yes'));
  await until(() => processGone(interruptedPid));
  await page.screenshot({ path: 'smoke-results/electron-terminal.png', fullPage: true });
  await fs.rm(path.join(root, 'terminal-foreground.pid'));
  await terminalCommand("sleep 30 & echo $! > terminal-background.pid; sh -c 'echo $$ > terminal-foreground.pid; exec sleep 30'");
  await until(async () => !!(await fs.stat(path.join(root, 'terminal-foreground.pid')).catch(() => null)));
  const terminalChildren = await Promise.all(['terminal-background.pid', 'terminal-foreground.pid'].map(async (file) => Number(await read(file))));
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  const terminalPluginDialog = page.getByRole('dialog'); await terminalPluginDialog.getByRole('button', { name: /^交互式终端/ }).click();
  await terminalPluginDialog.getByRole('button', { name: '停用', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.aether.terminal.get()))?.status === 'stopped');
  await until(() => processGone(terminalSession.pid) && terminalChildren.every(processGone));
  assert.equal(await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).count(), 0);
  await terminalPluginDialog.getByRole('button', { name: '启用', exact: true }).click(); await terminalPluginDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).click(); await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
  await page.locator('[data-terminal-status="running"]').waitFor();
  assert.notEqual((await page.evaluate(() => window.aether.terminal.get())).id, terminalSession.id);
  await terminalCommand("printf 'CLEAR_MARK:%s\\n' abc"); await until(async () => (await terminalText()).includes('CLEAR_MARK:abc'));
  await page.getByRole('button', { name: 'Clear terminal', exact: true }).click(); await until(async () => !(await terminalText()).includes('CLEAR_MARK:abc'));
  await terminalCommand('exit 7'); await page.locator('[data-terminal-status="exited"]').waitFor();
  assert.equal((await page.evaluate(() => window.aether.terminal.get())).exitCode, 7);
  await page.getByRole('button', { name: 'Start terminal', exact: true }).click(); await page.locator('[data-terminal-status="running"]').waitFor();
  const reloadPid = (await page.evaluate(() => window.aether.terminal.get())).pid;
  await page.getByRole('button', { name: '重新读取（放弃未保存修改）', exact: true }).click();
  await until(async () => (await page.evaluate(() => window.aether.terminal.get())).status === 'stopped' && processGone(reloadPid));
  await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).click(); await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
  await page.locator('[data-terminal-status="running"]').waitFor();
  const terminalPidAtExit = (await page.evaluate(() => window.aether.terminal.get())).pid;
  await page.setViewportSize(originalViewport);
  assert.deepEqual(errors, [], 'no renderer console errors');
  await app.close(); app = undefined;
  await until(() => processGone(terminalPidAtExit));
  await launch(); await page.getByText(root, { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => window.aether.runtime), 'electron');
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  const restoredDialog = page.getByRole('dialog');
  await restoredDialog.getByRole('button', { name: /^PlatformIO/ }).click();
  const restoredTool = restoredDialog.locator('[data-tool-id="platformio"]');
  await restoredTool.waitFor();
  if (process.env.AETHER_PLATFORMIO_CLI) {
    const restoredInput = restoredTool.getByRole('textbox', { name: 'PlatformIO CLI 可执行文件', exact: true });
    await until(async () => (await restoredInput.inputValue()) === process.env.AETHER_PLATFORMIO_CLI);
    assert.equal(await restoredInput.inputValue(), process.env.AETHER_PLATFORMIO_CLI);
  }
  await restoredDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('treeitem', { name: '重命名 目录', exact: true }).waitFor();
  assert.equal(await page.getByRole('treeitem', { name: '重命名 目录/新 名字.txt', exact: true }).count(), 0, 'trashed file stays deleted after reopening');
  await app.close(); app = undefined;
  console.log('PASS Electron: isolated preload, real disk folder open/edit/save/reopen, portable files, external edit refusal, new file, real clangd unsaved diagnostics/completion/F12 and plugin restart, PlatformIO compilation database and build/failure/cancel, Deploy dialog upload cancel and ESP preflight write block from a real build, Flash panel navigation/detect/backup cancel and port-ownership guard through the esptool CLI fixture, OS PTY and WebSocket UI round trips, real interactive shell keyboard/UTF-8/resize/Ctrl+C, panel persistence and process cleanup on disable/reload/exit; OS picker and port-list fixtures only, no hardware');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'smoke-results/electron-failure.png', fullPage: true }); await fs.writeFile('smoke-results/electron-failure.txt', error.stack + '\n' + errors.join('\n') + '\n' + await page.locator('body').innerText()); }
  throw error;
} finally {
  if (app) {
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
  }
  serialPeer?.kill(); await peer?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
