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
  const body = `Aether Studio ${version}，供桌面测试使用。` + '\n\n' +
    '下载对应系统和架构的文件：\n' +
    '- Windows x64：`.exe` 安装包，或 `.zip` 解压运行 `AetherStudio.exe`。\n' +
    '- macOS Apple Silicon / Intel：选择 `arm64` / `x64` 的 `.dmg` 或 `.zip`，运行 Aether Studio.app。\n' +
    '- Linux x64：`.AppImage` 或 `.tar.gz`。AppImage 需添加执行权限；无 FUSE 时可用 `--appimage-extract-and-run`。\n' +
    'macOS 使用 ad-hoc 临时签名，未经 Apple 公证；Windows 未做发布者签名，系统可能要求手动允许运行。\n\n' +
    '本版把桌面端的串口所有权收敛为宿主内唯一的仲裁器。串口监视器、构建/上传任务、Flash 备份/恢复、ESP 只读检测、部署前核对和 MicroPython 板载文件操作现在共用同一个单持有人租约，并按每次操作签发所有权令牌。任何一方占用端口期间，其他入口在打开端口或启动 esptool/mpremote 之前就被拒绝，错误信息写明端口与当前持有者；迟到的任务退出、过期的 `serial.close` 和已取消的操作只释放自己的令牌，不会释放后来者的所有权，任务的释放点仍是板载进程真实退出。ESP 只读检测把“宿主忙”“工具只读失败”“用户取消”区分开，不再把操作系统层的端口占用当作检测结果。\n\n' +
    '实板验收范围（beta.9，Windows，真实 Electron 应用 + 真实 preload API + 真实 SerialPort + 真实 esptool 4.9.0）：在一台 COM4 的 ESP32-C3（16MB，原生 USB-Serial/JTAG）上，无人占用时只读检测读到芯片、Flash 容量与 6 个厂商分区；真实原生监视器会话打开期间发起只读检测被宿主租约拒绝，原会话保持可读，关闭监视器后同一检测成功；反向场景中真实 esptool 检测进行时打开监视器被拒绝（以快照状态和检测结束为可观测边界，不使用固定延时），检测结束后重试成功；真实检测进行中取消会报告取消，并且只在 esptool 进程退出后释放端口。全程只执行 `flash_id`、0x8000 起始 4 KiB 的 `read_flash` 和 `get_security_info` 三类只读命令，没有任何写入、擦除、Flash 备份/恢复实机运行或 mpremote 操作。\n\n' +
    '未验证：固件/分区/数据的写入、擦除与恢复（含 Flash 备份/恢复面板）没有在真机上运行；MicroPython 板载文件与实际板载运行没有实机证据；ESP32-S3 没有实板证据。类型检查、软件 smoke 回归与四个平台的打包检查属于软件与构建证据，不接触硬件，不能当作实板通过。\n\n' +
    '内含 16 个插件、磁盘工作区、Monaco、C/C++ clangd 接口、真实 PlatformIO 任务、交互终端、串口、WebSocket 和可配置的 AI。PlatformIO 与 clangd 需自行安装；AI 非必选。可在应用内为 PlatformIO 与 clangd 保存可执行文件路径（应用数据目录 tools.json），重启后仍生效，构建、上传、编译数据库与语言服务使用该路径。磁盘工程支持新建文件与目录、重命名、移入系统回收站，并可按文件审阅外部修改、新增或删除；处理一个文件不会丢弃其他未保存缓冲区。Demo Simulation 仅生成数据。\n\n' +
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
