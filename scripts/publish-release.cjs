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
  const body = `Aether Studio ${version}，供桌面测试使用。

下载对应系统和架构的文件：
- Windows x64：\`.exe\` 安装包，或 \`.zip\` 解压运行 \`AetherStudio.exe\`。
- macOS Apple Silicon / Intel：选择 \`arm64\` / \`x64\` 的 \`.dmg\` 或 \`.zip\`，运行 Aether Studio.app。
- Linux x64：\`.AppImage\` 或 \`.tar.gz\`。AppImage 需添加执行权限；无 FUSE 时可用 \`--appimage-extract-and-run\`。
macOS 使用 ad-hoc 临时签名，未经 Apple 公证；Windows 未做发布者签名，系统可能要求手动允许运行。

本版新增 **Firmware Verification（固件验证）** 面板（\`aether.firmware.verification\`），不取代 Demo Simulation。它把一条真实链路拆成四个可分别核对的阶段：真实 PlatformIO 构建 → 真实 Espressif QEMU 启动并由宿主生成随机挑战 → 通过既有部署对话框和 \`esp.upload\` 做 app-only 单段写入 → 写入后新开串口会话再次挑战。宿主签发的仿真证据绑定 app SHA-256、PlatformIO 环境和工程输入指纹；只有与私有写入快照完全一致的同一 app 才能获得 app-only 授权，写入前仍要核对芯片、eFuse 安全状态、板上分区表、OTA 活动槽、bootloader/app IDF 版本与 4KB 擦除范围。QEMU 真固件宿主模块支持有界 UART 写入/读取、超时、取消与失败收束，并拒绝被替换的构建产物和构建后改动的工程输入。示例工程 \`examples/esp32c3-firmware-validation\` 使用 ESP-IDF 5.4.1；应用在启动时发送 READY，并在宿主发送 \`HELLO\` 时为当前连接补发一次，因此宿主可以在启动后才打开串口。共享的纯状态机负责判定 READY、挑战、响应、超时、断连、陈旧 token 与不匹配值。

实板验收范围（beta.10，Windows 10，真实打包 Electron 应用 + 真实 preload IPC + 真实 PlatformIO 6.1.19/ESP-IDF 5.4.1 + 真实 Espressif QEMU 9.2.2 \`esp_develop_9.2.2_20260417\` + 真实 esptool 4.8.9）：在 COM4 的 ESP32-C3（16MB，原生 USB-Serial/JTAG，芯片 rev v0.4）上，产品内构建得到 \`firmware.bin\` 200,928 字节、SHA-256 \`c3c87da8e89a36a540271309514a0aaebe9f2e93bba40e5fe8e68d2fb25f208d\`；同一 app 在 QEMU 中两次独立启动、每次新随机挑战均通过，固件标识 \`aether-c3-fwval-1\` 一致。真实只读预检确认活动槽 \`ota_1 @ 0x700000\`（OTA seq 2、state 2 = VALID）、bootloader IDF v5.4、app IDF 5.4.1；app-only 写入只擦除并写入 \`0x700000\`–\`0x731FFF\`（204,800 字节窗口），esptool 写入 200,928 字节并校验哈希，任务记录的实际写入段与预检计划一致，写入的 app SHA 与仿真记录一致。写入后新开串口会话，新挑战 \`b679e28c0e891a64\` 得到 \`b2aa395c\`，与宿主重算一致，并绑定本次部署计划摘要 \`ba8469e3…\`。四个阶段由产品 UI 产生。另以真实 QEMU 验证了运行中取消（记为失败、无残留进程）、验证后修改工程文件的证据失效拒绝、app SHA/环境/端口不匹配拒绝，以及端口被其他持有者占用时实机挑战在打开端口前被拒绝。

边界：这只是一台专用测试板、一个 ESP-IDF 示例和 ESP32-C3 的 UART0 / USB-Serial-JTAG 通路；QEMU 只模拟 SoC 与 UART0，不是电路电气仿真，也不代表所有固件、所有芯片或所有开发板。QEMU 不模拟 USB-Serial/JTAG。已在 Windows 10 实测；Linux/macOS 的该链路未实测。Windows 上 ESP-IDF 工程路径必须是纯 ASCII（CMake 会按系统 ANSI 代码页处理路径）。其他未验证项：其他板型/固件的 app-only 写入、完整镜像/bootloader/分区表写入、Flash 恢复、ESP32-S3 实板、MicroPython 实机行为。

内含 17 个插件、磁盘工作区、Monaco、C/C++ clangd 接口、真实 PlatformIO 任务、交互终端、串口、WebSocket 和可配置的 AI。PlatformIO 与 clangd 需自行安装；AI 非必选。可在应用内为 PlatformIO、clangd、esptool 与 QEMU 保存可执行文件路径（应用数据目录 tools.json），重启后仍生效。磁盘工程支持新建文件与目录、重命名、移入系统回收站，并可按文件审阅外部修改、新增或删除；处理一个文件不会丢弃其他未保存缓冲区。Demo Simulation 仅生成数据。

SHA256SUMS 提供全部下载文件的 SHA-256。

源码提交：${context.sha}
构建校验：https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}
`;
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
