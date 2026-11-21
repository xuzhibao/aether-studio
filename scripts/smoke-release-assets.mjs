// Release-file acceptance: install or unpack EVERY public file for this target and launch it.
//
// The unpacked app directory that `electron-builder --dir` produces is not a release file. This
// script starts from the files a user actually downloads (NSIS installer, ZIP, AppImage, tar.gz,
// DMG) inside the CI runner's own temporary directory, installs/extracts them with the platform
// tool, launches the executable that came out of that file through the existing `smoke:release`
// UI check, and records the file name, SHA-256, the absolute path it launched, the result and the
// target OS/arch.
//
// It copies exactly the tested bytes to `release-verified/` so the upload step can only ship what
// was tested, and writes `release-verification/acceptance-<target>.json` so the publish job can
// compare those bytes with the assets it is about to make public.
//
// The launched process is always `process.execPath scripts/smoke-release.mjs` (no shell, so nothing
// depends on npm.cmd resolution on Windows). Linux wraps it in xvfb-run like the existing job did.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const target = process.env.AETHER_RELEASE_TARGET;
assert.ok(target, 'AETHER_RELEASE_TARGET must name one release target');

// Names follow `artifactName` in package.json plus electron-builder's own arch spelling per target.
const EXPECTED = {
  'windows-x64': [
    { os: 'win', arch: 'x64', extension: 'exe', method: 'nsis-silent-install-and-launch' },
    { os: 'win', arch: 'x64', extension: 'zip', method: 'zip-unpack-and-launch' },
  ],
  'linux-x64': [
    { os: 'linux', arch: 'x86_64', extension: 'AppImage', method: 'appimage-extract-and-launch' },
    { os: 'linux', arch: 'x64', extension: 'tar.gz', method: 'tar-unpack-and-launch' },
  ],
  'macos-arm64': [
    { os: 'mac', arch: 'arm64', extension: 'dmg', method: 'dmg-app-and-launch' },
    { os: 'mac', arch: 'arm64', extension: 'zip', method: 'zip-app-and-launch' },
  ],
  'macos-x64': [
    { os: 'mac', arch: 'x64', extension: 'dmg', method: 'dmg-app-and-launch' },
    { os: 'mac', arch: 'x64', extension: 'zip', method: 'zip-app-and-launch' },
  ],
};
const expected = EXPECTED[target];
assert.ok(expected, 'unknown AETHER_RELEASE_TARGET: ' + target);

// Each target may only be accepted on its own native runner. `x86_64` is a file name for the
// AppImage, not Node's `process.arch`.
const RUNNERS = {
  'windows-x64': ['win32', 'x64'],
  'linux-x64': ['linux', 'x64'],
  'macos-arm64': ['darwin', 'arm64'],
  'macos-x64': ['darwin', 'x64'],
};
const [runnerPlatform, runnerArch] = RUNNERS[target];
assert.equal(process.platform, runnerPlatform, `${target} must run on ${runnerPlatform}, this is ${process.platform}`);
assert.equal(process.arch, runnerArch, `${target} must run on ${runnerArch}, this is ${process.arch}`);

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const releaseDirectory = 'release';
const verifiedDirectory = 'release-verified';
const summaryDirectory = 'release-verification';
const temp = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'aether-release-files-'));
const nameOf = (item) => `Aether-Studio-${version}-${item.os}-${item.arch}.${item.extension}`;
const label = (item) => item.extension.replace(/[^A-Za-z0-9]/g, '');

const log = (line) => console.log('[release-assets] ' + line);
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
  const timer = options.timeout ? setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`${command} timed out after ${options.timeout} ms`));
  }, options.timeout) : undefined;
  child.once('error', (error) => { if (timer) clearTimeout(timer); reject(error); });
  child.once('exit', (code, signal) => {
    if (timer) clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`));
  });
});
const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const until = async (test, what, attempts = 240, delay = 500) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await test()) return;
    await new Promise((done) => setTimeout(done, delay));
  }
  throw new Error('timed out waiting for ' + what);
};
const exists = (file) => fs.stat(file).then(() => true, () => false);

// Find the executable an extracted archive actually contains, whatever its top-level folder is.
// AppImage trees can duplicate the binary behind `usr/bin` symlinks, so only the shallowest match
// counts — that is the one the archive puts in front of the user.
const findExecutable = async (root, name, maxDepth = 4) => {
  const matches = [];
  const walk = async (directory, depth) => {
    if (depth > maxDepth) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === name) matches.push({ full, depth, link: entry.isSymbolicLink() });
    }
  };
  await walk(root, 0);
  const shallowest = Math.min(...matches.map((match) => match.depth));
  const top = Number.isFinite(shallowest) ? matches.filter((match) => match.depth === shallowest) : [];
  assert.equal(top.length, 1, `expected exactly one ${name} at the top of ${root}, found ${matches.length}: ${matches.map((match) => match.full).join(', ')}`);
  return top[0].full;
};

// The release directory must hold exactly this target's two public files.
const publicFiles = (await fs.readdir(releaseDirectory))
  .filter((file) => /^Aether-Studio-.*\.(exe|zip|dmg|AppImage|tar\.gz)$/.test(file));
const wanted = expected.map(nameOf);
assert.deepEqual([...publicFiles].sort(), [...wanted].sort(),
  `release/ must contain exactly ${wanted.join(', ')}, found ${publicFiles.join(', ') || 'nothing'}`);

const extractZip = async (file, directory) => {
  await fs.mkdir(directory, { recursive: true });
  if (process.platform === 'darwin') await run('ditto', ['-x', '-k', file, directory], { timeout: 10 * 60 * 1000 });
  else await run('tar', ['-xf', file, '-C', directory], { timeout: 10 * 60 * 1000 });
};

// Returns the absolute executable path produced by installing/extracting this public file.
const prepare = async (item, file, workRoot) => {
  const directory = path.join(workRoot, label(item));
  if (item.extension === 'exe') {
    // NSIS assisted installer: /S is silent; /D= picks the target directory and must come last,
    // unquoted. Node quotes arguments containing spaces, which NSIS cannot parse, so the target
    // directory is required to be space-free (RUNNER_TEMP and the label are).
    await fs.mkdir(directory, { recursive: true });
    assert.ok(!path.dirname(directory).includes(' '), 'the NSIS target directory must not contain spaces: ' + directory);
    const installer = path.join(workRoot, path.basename(file));
    await fs.copyFile(file, installer);
    log(`installing ${path.basename(file)} into ${directory}`);
    await run(installer, ['/S', '/D=' + directory], { cwd: workRoot, timeout: 20 * 60 * 1000 });
    const executable = path.join(directory, 'AetherStudio.exe');
    await until(() => exists(executable), 'the NSIS install to produce ' + executable);
    return executable;
  }
  if (item.extension === 'zip') {
    await extractZip(file, directory);
    if (process.platform === 'darwin') {
      const executable = await findExecutable(directory, 'Aether Studio');
      assert.match(executable, /\.app[\\/]Contents[\\/]MacOS[\\/]Aether Studio$/, 'the macOS ZIP must contain Aether Studio.app');
      return executable;
    }
    return findExecutable(directory, 'AetherStudio.exe');
  }
  if (item.extension === 'AppImage') {
    // Extraction avoids a FUSE dependency while still launching the binary that ships inside it.
    await fs.mkdir(directory, { recursive: true });
    const image = path.join(workRoot, path.basename(file));
    await fs.copyFile(file, image);
    await fs.chmod(image, 0o755);
    await run(image, ['--appimage-extract'], { cwd: directory, timeout: 15 * 60 * 1000 });
    return findExecutable(directory, 'aether-studio');
  }
  if (item.extension === 'tar.gz') {
    await fs.mkdir(directory, { recursive: true });
    await run('tar', ['-xzf', file, '-C', directory], { timeout: 10 * 60 * 1000 });
    return findExecutable(directory, 'aether-studio');
  }
  if (item.extension === 'dmg') {
    const mount = path.join(workRoot, 'mount-' + label(item));
    await fs.mkdir(mount, { recursive: true });
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mount, file], { timeout: 10 * 60 * 1000 });
    const source = path.join(mount, 'Aether Studio.app');
    const destination = path.join(directory, 'Aether Studio.app');
    try {
      await fs.mkdir(directory, { recursive: true });
      await until(() => exists(source), 'the DMG to contain Aether Studio.app');
      await run('ditto', [source, destination], { timeout: 10 * 60 * 1000 });
    } finally {
      await run('hdiutil', ['detach', mount], { timeout: 5 * 60 * 1000 }).catch(() => {});
    }
    const executable = path.join(destination, 'Contents', 'MacOS', 'Aether Studio');
    assert.ok(await exists(executable), 'the copied .app must contain ' + executable);
    return executable;
  }
  throw new Error('no preparation step for ' + item.extension);
};

const launch = async (executable, results) => {
  assert.ok(path.isAbsolute(executable), 'the launched path must be absolute: ' + executable);
  assert.ok(await exists(executable), 'the launched path must exist: ' + executable);
  const env = { ...process.env, AETHER_PACKAGED_EXECUTABLE: executable, AETHER_SMOKE_RESULTS: results };
  const script = path.resolve('scripts/smoke-release.mjs');
  log(`launching ${executable}`);
  // Direct node invocation: `npm.cmd` cannot be spawned without a shell on Windows.
  if (process.platform === 'linux') await run('xvfb-run', ['-a', process.execPath, script], { env, timeout: 30 * 60 * 1000 });
  else await run(process.execPath, [script], { env, timeout: 30 * 60 * 1000 });
};

const accepted = [];
for (const item of expected) {
  const file = path.join(releaseDirectory, nameOf(item));
  const absolute = path.resolve(file);
  const digest = await sha256(absolute);
  const size = (await fs.stat(absolute)).size;
  const executable = await prepare(item, absolute, path.join(temp, label(item) + '-work'));
  const resolved = await fs.realpath(executable);
  await launch(resolved, path.join('smoke-results', 'release-assets', target, label(item)));
  accepted.push({
    file: path.basename(file), sha256: digest, size, method: item.method,
    launchPath: resolved, launchResult: 'passed', targetOs: item.os, targetArch: item.arch,
  });
  log(`PASS ${path.basename(file)} sha256=${digest} size=${size} launched=${resolved}`);
}

// Only bytes that just passed may be uploaded.
await fs.mkdir(verifiedDirectory, { recursive: true });
for (const entry of accepted) await fs.copyFile(path.join(releaseDirectory, entry.file), path.join(verifiedDirectory, entry.file));

await fs.mkdir(summaryDirectory, { recursive: true });
const summary = { target, version, runnerPlatform: process.platform, runnerArch: process.arch, createdAt: new Date().toISOString(), files: accepted };
await fs.writeFile(path.join(summaryDirectory, `acceptance-${target}.json`), JSON.stringify(summary, null, 2) + '\n');
console.log('[release-assets] ' + JSON.stringify(summary));
console.log(`[release-assets] PASS ${target}: ${accepted.length} public files installed/unpacked and launched`);
