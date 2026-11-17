const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
module.exports = async ({ github, context }) => {
  const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const tag = 'v' + version;
  const expected = [
    ['linux', 'x86_64', 'AppImage'], ['linux', 'x64', 'tar.gz'],
    ['win', 'x64', 'exe'], ['win', 'x64', 'zip'],
    ['mac', 'x64', 'dmg'], ['mac', 'x64', 'zip'],
    ['mac', 'arm64', 'dmg'], ['mac', 'arm64', 'zip'],
  ].map(([os, arch, extension]) => `Aether-Studio-${version}-${os}-${arch}.${extension}`);
  const directory = 'release-assets'; const checksums = []; const hashes = new Map();
  for (const file of expected) {
    const data = await fs.readFile(path.join(directory, file));
    const hash = crypto.createHash('sha256').update(data).digest('hex'); hashes.set(file, hash);
    checksums.push(hash + '  ' + file);
  }
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
  const body = `Aether Studio ${version}，供桌面测试使用。\n\n` +
    '下载对应系统和架构的文件：\n\n' +
    '- Windows x64：`.exe` 安装包，或 `.zip` 解压运行 `AetherStudio.exe`。\n' +
    '- macOS Apple Silicon / Intel：选择 `arm64` / `x64` 的 `.dmg` 或 `.zip`，运行 Aether Studio.app。\n' +
    '- Linux x64：`.AppImage` 或 `.tar.gz`。AppImage 需添加执行权限；无 FUSE 时可用 `--appimage-extract-and-run`。\n\n' +
    'macOS 使用 ad-hoc 临时签名，未经 Apple 公证；Windows 未做发布者签名，系统可能要求手动允许运行。\n\n' +
    '内含 14 个插件、磁盘工作区、Monaco、C/C++ clangd 接口、真实 PlatformIO 任务、交互终端、串口、WebSocket 和可配置的 AI。PlatformIO 与 clangd 需自行安装；AI 非必选。可在应用内为 PlatformIO 与 clangd 保存可执行文件路径（应用数据目录 tools.json），重启后仍生效，构建、上传、编译数据库与语言服务使用该路径。磁盘工程支持新建文件与目录、重命名、移入系统回收站，并可按文件审阅外部修改、新增或删除；处理一个文件不会丢弃其他未保存缓冲区。Demo Simulation 仅生成数据；真实开发板烧录、串口设备与硬件行为未在本次构建中验证。\n\n' +
    '各目标已通过打包后启动、插件、原生终端与文件写入冒烟；完整工作流主要在 Linux 检查。开发板烧录、串口设备和平台细节请自行测试。\n\n' +
    'SHA256SUMS 提供全部下载文件的 SHA-256。\n\n' +
    `源码提交：${context.sha}\n构建校验：https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}\n`;
  const repository = context.repo;
  let release;
  try { release = (await github.rest.repos.getReleaseByTag({ ...repository, tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  if (release) {
    if (!release.draft) throw new Error('Release already published; refusing to replace public assets: ' + tag);
    if (release.target_commitish !== context.sha) throw new Error('Draft belongs to a different commit');
  } else {
    release = (await github.rest.repos.createRelease({ ...repository, tag_name: tag, target_commitish: context.sha, name: `Aether Studio ${tag}`, body, draft: true, prerelease: version.includes('-') })).data;
  }
  const existing = (await github.rest.repos.listReleaseAssets({ ...repository, release_id: release.id, per_page: 100 })).data;
  for (const name of [...expected, 'SHA256SUMS']) {
    const old = existing.find((asset) => asset.name === name);
    if (old) await github.rest.repos.deleteReleaseAsset({ ...repository, asset_id: old.id });
    const data = await fs.readFile(path.join(directory, name));
    await github.rest.repos.uploadReleaseAsset({ ...repository, release_id: release.id, name, data, headers: { 'content-type': 'application/octet-stream', 'content-length': data.length } });
  }
  const uploaded = (await github.rest.repos.listReleaseAssets({ ...repository, release_id: release.id, per_page: 100 })).data;
  for (const name of [...expected, 'SHA256SUMS']) {
    const asset = uploaded.find((item) => item.name === name);
    const size = (await fs.stat(path.join(directory, name))).size;
    if (!asset || asset.state !== 'uploaded' || asset.size !== size) throw new Error('Incomplete uploaded asset: ' + name);
    if (asset.digest && hashes.has(name) && asset.digest !== 'sha256:' + hashes.get(name)) throw new Error('Uploaded checksum mismatch: ' + name);
  }
  await github.rest.repos.updateRelease({ ...repository, release_id: release.id, body, draft: false, prerelease: version.includes('-'), make_latest: version.includes('-') ? 'false' : 'true' });
  console.log('Published ' + release.html_url);
};
