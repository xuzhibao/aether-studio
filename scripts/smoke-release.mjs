import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-release-'));
const directory = path.join(temp, 'project'); await fs.mkdir(directory); const root = await fs.realpath(directory);
await fs.writeFile(path.join(root, 'release.txt'), 'Release launch smoke\n');
await fs.mkdir('smoke-results', { recursive: true });
let app, page; const errors = [];
const executable = process.env.AETHER_PACKAGED_EXECUTABLE;
assert.ok(executable, 'AETHER_PACKAGED_EXECUTABLE must point to the packaged app');
const until = async (test) => { for (let n = 0; n < 200; n++) { if (await test()) return; await new Promise((done) => setTimeout(done, 100)); } throw new Error('Release smoke timed out'); };
try {
  const env = { ...process.env, AETHER_USER_DATA_DIR: path.join(temp, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: executable, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 45000 });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.locator('nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('dialog').getByText('本地内置插件 · 14 / 14 已启用', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, root);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByPlaceholder('Search commands, files and actions…').fill('Open project folder'); await page.keyboard.press('Enter');
  await page.getByText(root, { exact: true }).first().waitFor();
  await page.locator('nav').getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Start terminal', exact: true }).click();
  await page.locator('[data-terminal-status="running"]').waitFor();
  const session = await page.evaluate(() => window.aether.terminal.get()); assert.equal(session.root, root);
  await page.evaluate(({ id, windows }) => window.aether.terminal.write(id, windows ? 'echo RELEASE_PTY_OK> native-pty.txt\r' : "printf RELEASE_PTY_OK > native-pty.txt\r"), { id: session.id, windows: process.platform === 'win32' });
  await until(async () => (await fs.readFile(path.join(root, 'native-pty.txt'), 'utf8').catch(() => '')).trim() === 'RELEASE_PTY_OK');
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await page.locator('[data-terminal-status="stopped"]').waitFor();
  await page.screenshot({ path: 'smoke-results/release-' + process.platform + '-' + process.arch + '.png', fullPage: true });
  assert.deepEqual(errors, [], 'no renderer console errors');
  const version = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(version, JSON.parse(await fs.readFile('package.json', 'utf8')).version);
  await app.close(); app = undefined;
  if (process.platform === 'darwin') {
    const appBundle = path.resolve(executable, '../../..');
    await promisify(execFile)('codesign', ['--verify', '--deep', '--strict', appBundle]);
  }
  console.log(`PASS packaged ${process.platform}/${process.arch}: v${version}, 14 plugins, isolated renderer, actual project picker I/O, native PTY write and shutdown`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: 'smoke-results/release-failure.png', fullPage: true }); await fs.writeFile('smoke-results/release-failure.txt', String(error.stack) + '\n' + errors.join('\n') + '\n' + await page.locator('body').innerText()); }
  throw error;
} finally {
  if (app) { const child = app.process(); if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); }); }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
