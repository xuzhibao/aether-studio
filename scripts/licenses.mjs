import { readFile, readdir, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const destination = 'dist-licenses';
await rm(destination, { recursive: true, force: true }); await mkdir(destination);
const rows = [];
for (const [directory, entry] of Object.entries(lock.packages)) {
  if (!directory || entry.dev || !directory.includes('node_modules/')) continue;
  const data = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const slug = directory.replaceAll('/', '__');
  const folder = path.join(destination, slug); await mkdir(folder);
  for (const file of await readdir(directory)) {
    if (/^(licen[sc]e|copying|notice|ofl)([.-]|$)/i.test(file)) {
      try { await copyFile(path.join(directory, file), path.join(folder, file)); } catch (error) { if (error.code !== 'EISDIR') throw error; }
    }
  }
  rows.push(`| ${data.name} | ${data.version} | ${typeof data.license === 'string' ? data.license : JSON.stringify(data.license ?? 'UNDECLARED')} |`);
}
await mkdir(path.join(destination, 'node-pty-bundled'));
await copyFile('node_modules/node-pty/deps/winpty/LICENSE', path.join(destination, 'node-pty-bundled', 'winpty-LICENSE'));
await copyFile('third_party/ConPTY-LICENSE.txt', path.join(destination, 'node-pty-bundled', 'ConPTY-LICENSE'));
await mkdir(path.join(destination, 'electron'));
for (const file of await readdir('node_modules/electron/dist')) if (/^LICENSE/.test(file)) await copyFile('node_modules/electron/dist/' + file, path.join(destination, 'electron', file));
await copyFile('NOTICE', path.join(destination, 'NOTICE'));
await writeFile('THIRD_PARTY_NOTICES.md', '# Third-party notices\n\nAether Studio original code uses Apache-2.0. Third-party components retain the licenses below. Full available notices are copied to `dist-licenses/` by `npm run licenses` and included in desktop packaging. Electron and Chromium notices are included separately.\n\nThis inventory records installed package metadata; it is not a claim that all upstream SDK binaries or model weights have available source. External PlatformIO platforms, compiler packages and target firmware are not bundled by Aether. Their licenses must be checked for the selected project and tool version.\n\n| Package | Version | Declared license |\n| --- | --- | --- |\n' + rows.sort().join('\n') + '\n\nnode-pty also ships winpty (MIT, Copyright Ryan Prichard) and ConPTY/OpenConsole (MIT, Copyright Microsoft Corporation). Their notices are included under `dist-licenses/node-pty-bundled/`. ConPTY license source: https://github.com/microsoft/terminal/blob/main/LICENSE .\n');
console.log(`Collected notices for ${rows.length} production packages and Electron runtime`);
