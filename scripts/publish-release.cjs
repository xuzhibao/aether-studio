const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Publishes the bytes that passed the per-target release-file acceptance on their own runners.
//
// Layout produced by `.github/workflows/release.yml`:
//   release-accepted/release-verified/<file>                  exactly the tested files
//   release-accepted/release-acceptance/acceptance-*.json     one summary per runner, nothing else
//
// Nothing is published unless all four summaries exist and agree with this version, each one reports
// the real runner OS/arch, each records the app it launched and a SHA-256, and the summarized digest
// still equals the bytes about to be uploaded. That is what stops a same-named re-pack from replacing
// an accepted file.
//
// Existing releases, tags and assets are never deleted or replaced. A pre-existing draft is reused
// only when its assets are byte-identical; anything else aborts the run.

// One entry per runner: the two public files that runner must have installed/unpacked and launched,
// plus the Node platform/arch that runner must report (AppImage's `x86_64` is a file name, not
// `process.arch`).
const TARGETS = {
  'windows-x64': { platform: 'win32', arch: 'x64', files: [['win', 'x64', 'exe'], ['win', 'x64', 'zip']] },
  'linux-x64': { platform: 'linux', arch: 'x64', files: [['linux', 'x86_64', 'AppImage'], ['linux', 'x64', 'tar.gz']] },
  'macos-arm64': { platform: 'darwin', arch: 'arm64', files: [['mac', 'arm64', 'dmg'], ['mac', 'arm64', 'zip']] },
  'macos-x64': { platform: 'darwin', arch: 'x64', files: [['mac', 'x64', 'dmg'], ['mac', 'x64', 'zip']] },
};

const digestOf = (file) => fs.readFile(file).then((data) => crypto.createHash('sha256').update(data).digest('hex'));
const isAbsoluteFor = (target, value) => (TARGETS[target].platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value));

module.exports = async ({ github, context }) => {
  const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const tag = 'v' + version;
  const directory = 'release-accepted/release-verified';
  const summariesDirectory = 'release-accepted/release-acceptance';
  const repository = context.repo;
  const expected = Object.entries(TARGETS).flatMap(([target, entry]) =>
    entry.files.map(([os, arch, extension]) => ({ target, os, arch, extension, name: `Aether-Studio-${version}-${os}-${arch}.${extension}` })));
  const expectedNames = expected.map((item) => item.name);

  // --- 1. The tag must not already exist, or must already resolve to this commit.
  // `getReleaseByTag` alone is not enough: `target_commitish` cannot override a tag that already
  // points somewhere else, and annotated tags need to be dereferenced to their final commit.
  const resolveTag = async () => {
    try {
      const ref = (await github.rest.git.getRef({ ...repository, ref: 'tags/' + tag })).data;
      if (ref.object.type === 'tag') {
        const annotated = (await github.rest.git.getTag({ ...repository, tag_sha: ref.object.sha })).data;
        return annotated.object.type === 'commit' ? annotated.object.sha : null;
      }
      return ref.object.type === 'commit' ? ref.object.sha : null;
    } catch (error) { if (error.status === 404) return undefined; throw error; }
  };
  const tagCommit = await resolveTag();
  if (tagCommit !== undefined && tagCommit !== context.sha) {
    throw new Error(`tag ${tag} already exists at ${tagCommit}, not at ${context.sha}; refusing to move it`);
  }

  // --- 2. Four acceptance summaries, one per target, agreeing on names, digests and runner.
  const summaryFiles = (await fs.readdir(summariesDirectory)).filter((file) => /^acceptance-.*\.json$/.test(file));
  if (summaryFiles.length !== Object.keys(TARGETS).length) {
    throw new Error(`expected ${Object.keys(TARGETS).length} release acceptance summaries, found ${summaryFiles.length}: ${summaryFiles.join(', ') || 'none'}`);
  }
  const accepted = new Map();
  for (const [target, { platform, arch, files }] of Object.entries(TARGETS)) {
    const summary = JSON.parse(await fs.readFile(path.join(summariesDirectory, `acceptance-${target}.json`), 'utf8'));
    if (summary.target !== target) throw new Error(`summary ${target} reports target ${summary.target}`);
    if (summary.version !== version) throw new Error(`summary ${target} was produced for ${summary.version}`);
    if (summary.runnerPlatform !== platform || summary.runnerArch !== arch) {
      throw new Error(`summary ${target} came from ${summary.runnerPlatform}/${summary.runnerArch}, expected ${platform}/${arch}`);
    }
    if (!Array.isArray(summary.files) || summary.files.length !== files.length) throw new Error(`summary ${target} must describe exactly ${files.length} public files`);
    for (const [os, fileArch, extension] of files) {
      const name = `Aether-Studio-${version}-${os}-${fileArch}.${extension}`;
      const entry = summary.files.find((item) => item.file === name);
      if (!entry) throw new Error(`summary ${target} is missing ${name}`);
      if (entry.targetOs !== os || entry.targetArch !== fileArch) throw new Error(`summary ${target} has ${name} as ${entry.targetOs}/${entry.targetArch}`);
      if (entry.launchResult !== 'passed') throw new Error(`summary ${target} did not record a passing launch for ${name}`);
      if (!entry.launchPath || !isAbsoluteFor(target, entry.launchPath)) {
        throw new Error(`summary ${target} must record the absolute launched path for ${name}, got ${entry.launchPath}`);
      }
      if (!/^[0-9a-f]{64}$/.test(entry.sha256 || '')) throw new Error(`summary ${target} has no SHA-256 for ${name}`);
      if (accepted.has(name)) throw new Error(`file ${name} was accepted by more than one target`);
      accepted.set(name, entry);
    }
  }
  if (accepted.size !== expectedNames.length) throw new Error(`summaries cover ${accepted.size} files, expected ${expectedNames.length}`);

  // --- 3. The bytes about to be published must be exactly the accepted ones.
  const present = (await fs.readdir(directory)).sort();
  if (JSON.stringify(present) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(`verified payload must be exactly the eight expected files, found: ${present.join(', ') || 'nothing'}`);
  }
  const checksums = [];
  for (const name of expectedNames) {
    const file = path.join(directory, name);
    const hash = await digestOf(file);
    const entry = accepted.get(name);
    if (hash !== entry.sha256) throw new Error(`verified payload no longer matches its acceptance summary (was the file re-packed?): ${name}`);
    if ((await fs.stat(file)).size !== entry.size) throw new Error(`verified payload size differs from the accepted size: ${name}`);
    checksums.push(hash + '  ' + name);
  }
  // Written beside the payload, not inside it: the payload directory must keep exactly eight files.
  const sumsFile = 'release-accepted/SHA256SUMS';
  await fs.writeFile(sumsFile, checksums.join('\n') + '\n');

  const body = `Aether Studio ${version}（第一个正式版）。

下载对应系统和架构的文件：
- Windows x64：\`.exe\` 安装包，或 \`.zip\` 解压运行 \`AetherStudio.exe\`。
- macOS Apple Silicon / Intel：选择 \`arm64\` / \`x64\` 的 \`.dmg\` 或 \`.zip\`，运行 Aether Studio.app。
- Linux x64：\`.AppImage\` 或 \`.tar.gz\`。AppImage 需添加执行权限；无 FUSE 时可用 \`--appimage-extract-and-run\`。
macOS 使用 ad-hoc 临时签名，未经 Apple 公证；Windows 未做发布者签名。本版没有新增代码签名，也没有配置公证。

## 本版内容

本版新增**自动固件任务模式**（内置插件 \`aether.firmware.dev\`，随 Agent 面板提供）：用户显式开始后，内置 Agent 通过类型化工具依次完成「读取授权源码 → 受控编辑 → 真实 PlatformIO 构建 → 真实 QEMU 两次启动与宿主随机挑战 → 只读预检 → 同一镜像的 app-only 单段写入 → 新串口会话实机挑战 → COUNT 稳定性观察」。终态以宿主阶段为准，模型自称成功不算通过；停止会立即中断真实进程、撤销剩余读写授权，不自动回滚已开始的写入。它复用 Firmware Verification 的校验链路，不取代该面板，也不改变普通部署的既有硬阻断。

## 验收范围（如实说明）

- **Windows 实板**：在一台 ESP32-C3 专用测试板（原生 USB-Serial/JTAG，16 MB）上，用**本地构建的 Windows 生产版 Electron 应用**（真实 preload IPC）、真实 PlatformIO 6.1.19 / ESP-IDF 5.4.1、真实 Espressif QEMU 9.2.2 与真实 esptool 跑通两轮独立任务；每轮由产品内 Agent 自行编辑、真实构建、两次 QEMU 新挑战、只读预检、app-only 单段写入、新串口会话实机挑战、20 次严格递增 COUNT 与 60 秒无重启/看门狗观察。另有三条拒绝路径（端口被占用、写入前取消、过期预览）都在写入开始前被宿主拒绝，零写入任务。两轮是独立实现与独立构建，app SHA 不同。这些实板结果来自该本地生产构建，不是在安装本页下载的发行包之后完成的硬件验收。
- **Linux / macOS**：只完成发行包验收（安装或解包本页实际下载文件并启动），没有实板，也没有真实构建/写入链路的行为验收。
- **未覆盖**：OLED 等外设、断点调试、写入中途断电或拔线后的设备状态、其他芯片/板型/固件、完整镜像与分区表写入、ESP32-S3 实板。QEMU 只模拟 ESP32-C3 SoC 与 UART0，不是电路电气仿真，也不模拟 USB-Serial/JTAG。

## 发行文件验收

四个原生 runner 各自针对本次上传的**实际发行文件**做安装或解包并启动：Windows 跑 NSIS 静默安装和 ZIP 解包，Linux 跑 AppImage 解包与 tar.gz 解包，两个 macOS 目标各从 DMG 和 ZIP 取出 .app 启动。每份文件都记录了文件名、SHA-256、安装/解包后实际启动的绝对路径、启动结果与目标 OS/架构；发布前再次比对这些摘要与待上传字节，任何同名重打包都会使发布失败。

内置 18 个插件，含本版新增的自动固件任务插件，另有磁盘工作区、Monaco、C/C++ clangd 接口、真实 PlatformIO 任务、交互终端、串口、WebSocket 和可配置的 AI。PlatformIO 与 clangd 需自行安装；AI 非必选。可在应用内为 PlatformIO、clangd、esptool 与 QEMU 保存可执行文件路径（应用数据目录 tools.json），重启后仍生效。磁盘工程支持新建文件与目录、重命名、移入系统回收站，并可按文件审阅外部修改、新增或删除；处理一个文件不会丢弃其他未保存缓冲区。Demo Simulation 仅生成数据。

SHA256SUMS 提供全部下载文件的 SHA-256。

源码提交：${context.sha}
构建校验：https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}
`;

  // --- 4. Reuse an existing draft only if it belongs to this commit; never touch a public release.
  let release;
  try { release = (await github.rest.repos.getReleaseByTag({ ...repository, tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  if (release && !release.draft) throw new Error('Release already published; refusing to replace public assets: ' + tag);
  if (release && release.target_commitish !== context.sha) throw new Error('Draft belongs to a different commit');
  if (!release) {
    release = (await github.rest.repos.createRelease({ ...repository, tag_name: tag, target_commitish: context.sha, name: `Aether Studio ${tag}`, body, draft: true, prerelease: false })).data;
  }

  // --- 5. Re-hash the bytes actually read now (all nine, SHA256SUMS included) before any upload.
  const wanted = [...expectedNames, 'SHA256SUMS'];
  const localFile = (name) => (name === 'SHA256SUMS' ? sumsFile : path.join(directory, name));
  const downloadedDigest = async (assetId) => {
    const response = await github.rest.repos.getReleaseAsset({ ...repository, asset_id: assetId, headers: { accept: 'application/octet-stream' } });
    return crypto.createHash('sha256').update(Buffer.from(response.data)).digest('hex');
  };
  const payload = new Map();
  for (const name of wanted) {
    const data = await fs.readFile(localFile(name));
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (name === 'SHA256SUMS') {
      const lines = data.toString('utf8').trim().split('\n');
      if (lines.length !== expectedNames.length) throw new Error(`SHA256SUMS must list ${expectedNames.length} files, has ${lines.length}`);
      for (const legalName of expectedNames) {
        const line = lines.find((entry) => entry.endsWith('  ' + legalName));
        const acceptedHash = accepted.get(legalName).sha256;
        if (!line || line.split(/\s+/)[0] !== acceptedHash) throw new Error('SHA256SUMS does not list the accepted digest for ' + legalName);
      }
    } else if (hash !== accepted.get(name).sha256) {
      throw new Error('asset bytes changed after verification (re-pack?): ' + name);
    }
    payload.set(name, { data, hash });
  }

  const existing = (await github.rest.repos.listReleaseAssets({ ...repository, release_id: release.id, per_page: 100 })).data;
  for (const name of wanted) {
    const { data, hash } = payload.get(name);
    const old = existing.find((asset) => asset.name === name);
    if (old) {
      // Never replace a differently named asset; an identical one is simply kept.
      const same = old.digest ? old.digest === 'sha256:' + hash : (await downloadedDigest(old.id)) === hash;
      if (!same) throw new Error(`draft already has a different asset named ${name}; refusing to replace it`);
      continue;
    }
    await github.rest.repos.uploadReleaseAsset({ ...repository, release_id: release.id, name, data, headers: { 'content-type': 'application/octet-stream', 'content-length': data.length } });
  }

  // --- 6. Verify every published asset by digest (or by downloading the bytes), never by size alone.
  const uploaded = (await github.rest.repos.listReleaseAssets({ ...repository, release_id: release.id, per_page: 100 })).data;
  for (const name of wanted) {
    const asset = uploaded.find((item) => item.name === name);
    if (!asset || asset.state !== 'uploaded') throw new Error('Incomplete uploaded asset: ' + name);
    const expectedHash = payload.get(name).hash;
    const actual = asset.digest ?? await downloadedDigest(asset.id);
    const normalized = String(actual).startsWith('sha256:') ? String(actual).slice(7) : String(actual);
    if (normalized !== expectedHash) throw new Error('Published asset checksum mismatch: ' + name);
  }

  await github.rest.repos.updateRelease({ ...repository, release_id: release.id, body, draft: false, prerelease: false, make_latest: 'true' });
  console.log('Published ' + release.html_url + ' with ' + expectedNames.length + ' verified assets');
};
