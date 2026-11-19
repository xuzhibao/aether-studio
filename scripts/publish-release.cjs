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
    '本版新增三项桌面能力。PlatformIO 构建任务结束后，任务卡片会在原始日志上方列出**编译器诊断**：只显示日志中能证明属于当前已加载工程源码的 GCC/Clang 行列，点击在编辑器打开该文件并定位，走现有编辑器跳转；诊断来自该任务结束时的日志快照，不是当前缓冲区状态，工程外、UNC、URI、含 `..` 的路径、非源码文件和未加载的文件只保留在原始日志中，原始日志、退出码与取消状态不变。\n\n' +
    '板载文件保存改为宿主签发的不透明单次授权：对话框结果不再把本地路径交给界面，授权在宿主内部绑定端口、设备文件绝对路径、当前工程与选择代次；对话框返回前后以及复制提交前都会复核，面板卸载、切换工程或关闭窗口会作废在途选择、取消运行中的下载并清理临时目录，绝不启动 mpremote 或发布成功。已有本地文件不会被覆盖，只会报错。\n\n' +
    '串口监视器默认跟随最新行：500 条有界缓冲长度不再增长时仍按行身份贴底；向上滚动停止跟随以便查看旧输出，可滚回底部或点击 **Jump to latest**，且只滚动列表自身；暂停、筛选、清空互不影响，原生串口会话日志与导出不受影响。\n\n' +
    '内含 16 个插件、磁盘工作区、Monaco、C/C++ clangd 接口、真实 PlatformIO 任务、交互终端、串口、WebSocket 和可配置的 AI。PlatformIO 与 clangd 需自行安装；AI 非必选。可在应用内为 PlatformIO 与 clangd 保存可执行文件路径（应用数据目录 tools.json），重启后仍生效，构建、上传、编译数据库与语言服务使用该路径。磁盘工程支持新建文件与目录、重命名、移入系统回收站，并可按文件审阅外部修改、新增或删除；处理一个文件不会丢弃其他未保存缓冲区。Demo Simulation 仅生成数据；真实开发板烧录、串口设备与硬件行为未在本次构建中验证。\n\n' +
    '各目标已通过打包后启动、插件、原生终端与文件写入冒烟；完整工作流主要在 Linux 检查。编译器诊断的点击跳转在 Linux 桌面冒烟中用真实 PlatformIO 编译失败日志验证；MicroPython 下载用不打开串口的假 CLI 与真实 Electron 验证（本机没有 mpremote 与开发板）；串口跟随由 WebSocket fixture 的 500 行环缓冲验证。本版未连接任何开发板、未打开真实串口，也未向硬件发送 TX；开发板烧录、真实串口设备和平台细节请自行测试。\n\n' +
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
