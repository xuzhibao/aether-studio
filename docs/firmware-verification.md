# 固件验证：真实 QEMU 与实机挑战（beta.10）

本文件说明产品内的 **Firmware Verification（固件验证）** 面板：它用一个真实、可复验的 ESP32-C3 示例，把构建、QEMU 挑战、显式写入与新串口挑战分开记录，避免把构建成功、退出码 0 或旧仿真记录当成设备在运行。

## 范围

- 示例工程：`examples/esp32c3-firmware-validation`，ESP-IDF 5.4.1，PlatformIO 环境 `esp32c3-qemu-uart0`。
- 仿真器：Espressif 官方 `qemu-system-riscv32`，`-machine esp32c3`，UART0 作为串口，运行由真实构建产物组装的私有 flash 镜像。
- 实机：ESP32-C3，应用只写入设备当前活动 OTA 槽（本示例约定 `ota_1 @ 0x700000`）内的单一 app 段；不写 bootloader、分区表、otadata、phy_init、`model` 或 `ota_0`。
- 已实测操作系统：Windows 10（x64）。Linux/macOS 未实测。

这**不是**电路电气仿真，也不代表所有固件、所有 ESP32 型号或所有开发板。QEMU 的 `esp32c3` 机器没有 USB 外设，因此只验证 UART0；原生 USB-Serial/JTAG 只在实体板上验证。

## 产品流程

流程按四个步骤驱动，每一步都有可观察的真实结果：

1. **保存并构建**：使用当前 PlatformIO 环境执行真实 `platformio run`；构建记录写入工程 `.aether/build.json`，包含所选环境、输入指纹、产物路径/大小/SHA-256。
2. **真实 QEMU 验证**：宿主读取成功的构建记录，复验 `firmware.bin`、`bootloader.bin`、`partitions.bin` 的大小与 SHA-256，确认工程输入指纹未变化，组装 QEMU 私有 flash 副本并再次校验镜像内的 app/bootloader/分区表三段；随后启动真实 QEMU。每次启动的挑战 token 由宿主新生成，响应由 `shared/firmwareValidation.ts` 的纯状态机判定。默认两次启动，两次的 app SHA 与固件标识必须一致。
3. **面板内显式写入**：点击“核对写入”时，宿主在端口租约内只读复查成功构建记录、产物 SHA-256、设备芯片、eFuse 安全状态、板上分区表、OTA 活动槽与 4KB 擦除范围，签发绑定工程、环境、输入指纹、QEMU 证据 ID、app SHA、端口与擦除范围的一次性预览。预览不打开通用部署权限；点击“烧录已验证 app”后才启动既有 `esp.upload` 的 app-only 单段路径，不再次构建、不隐式保存。写入前提供程序在任务自己的端口租约内再次复查设备、活动槽、构建记录与私有 app 快照；任一变化都会零写入拒绝。
4. **独立实机挑战**：写入成功后，宿主在所选端口新开一个串口会话，先发送 `HELLO` 要求当前通道重新发送 READY（应用可能在端口打开前就已启动），再生成新的挑战 token。只有同一会话中收到匹配的 `RESPONSE`，并且该会话晚于本次成功的 `esp.upload`、端口一致、观察到了真实输出，才标记“实机行为通过”。

## 可信证据与拒绝路径

- 仿真证据由宿主写入应用数据目录（`firmware-verification/qemu-evidence.json`），绑定 **app SHA-256、PlatformIO 环境、工程输入指纹** 与两次启动的挑战记录；渲染进程没有参数可以伪造或放宽它。
- 只有通过的记录才能签发写入预览；预览是一次性的，120 秒后过期，新的 QEMU 运行、工程/环境/端口切换或显式取消都会使其失效。提交与写入时再核对：证据未被新验证替换、工程目录一致、环境一致、端口一致、app SHA 与私有写入快照一致、输入指纹未变化。
- 写入计划摘要（端口 + 环境 + 各段名称/偏移/大小/SHA-256）随成功的 `esp.upload` 任务保存；实机挑战必须绑定到该摘要。
- 会被拒绝而不是误判通过的场景：
  - 旧证据被新的 QEMU 运行替换，或验证后工程文件/环境/端口变化；
  - 编辑未保存，或构建产物在验证后被替换、重建得到的 app SHA 不同；
  - 串口正被监视器、构建/上传任务或备份占用；
  - 预览已取消、已过期、已用于一次写入，或重复点击提交；
  - 通用部署（不带宿主内部标记）不会消耗专用预览；
  - 设备无响应、拔线、READY/响应超时、token 不匹配、回答值不匹配；
  - 上传退出码为 0 但没有同镜像的仿真绑定，或实机挑战没有绑定到本次部署。

## 环境限制

- **非 ASCII 工程路径**：Windows 上 ESP-IDF/CMake 会把工程路径按系统 ANSI 代码页写入构建文件，ASCII 之外的中文路径会编译失败。实测使用同一份源码的 ASCII 路径副本；产品不绕过该限制。建议把 ESP-IDF 工程放在纯 ASCII 路径。
- QEMU 与实机串口共用宿主端口租约；同一时刻只能有一个入口使用设备。
- esptool 需要带 `pyserial` 的 Python。若自定义 `PLATFORMIO_CORE_DIR` 只包含 platforms/packages 而没有 penv，宿主会回退到 `AETHER_ESPTOOL_PYTHON`、配置的 PlatformIO CLI 所在 penv、或默认的 `~/.platformio/penv`。
- 面板不提供“忽略检查”“整片擦除”“写入完整镜像”按钮；显式写入只出现在固件验证面板内，不跳转通用部署对话框。
- 常规面板只显示设备、目标槽、写入/擦除范围与简短结果；完整 SHA、原始进程输出和证据细节在日志、宿主证据文件与本文件中。

## 辅助命令

```bash
# 共享匹配器单测（无串口、无 QEMU）
node --import tsx --test examples/esp32c3-firmware-validation/tools/matcher.test.ts

# 部署前仿真证据门槛（宿主侧单元场景）
npm run smoke:esp:deploy-gate

# A 线的 QEMU 宿主模块真实验收（需要真实 PlatformIO 与 Espressif QEMU）
AETHER_PLATFORMIO_CLI=<platformio> AETHER_QEMU_RISCV32=<qemu-system-riscv32> npm run typecheck
node --import tsx scripts/smoke-qemu-simulator.ts
```

CLI 可以补充证据，但成功实机流程必须来自产品面板的真实运行；本仓库不使用 mock、虚拟串口或预录回包作为验收依据。

## 本轮实测记录（beta.10，2026-11-19，Windows 10）

- 产品：真实打包 Electron 应用（生产构建的 `dist` + `desktop-dist`），真实 preload IPC；自动化只替换系统文件选择器的返回值。
- 工具：PlatformIO Core 6.1.19、ESP-IDF 5.4.1、GCC `riscv32-esp-elf 14.2.0`、Espressif QEMU `9.2.2 (esp_develop_9.2.2_20261109)`、PlatformIO 自带 esptool；复用本机已安装的 GCC 14.2 工具链（隔离 PlatformIO core），避免重复下载完整工具链。
- 工程：`examples/esp32c3-firmware-validation` 的隔离 ASCII 路径副本，环境 `esp32c3-qemu-uart0`。
- 构建：本次会话只发生 **1 次** `platformio.build`。`firmware.bin` 203,232 字节，SHA-256 `3820ee9a757245b30fd95bce13b2e207ad36e686988f27b9818e4a323cce7142`；`bootloader.bin` 21,072 字节；`partitions.bin` 3,072 字节。
- QEMU：同一 app 两次独立启动，每次新随机挑战通过；固件标识 `aether-c3-fwval-1` 一致，返回的 app SHA 与构建产物一致。
- 实机（COM4，VID:PID `303A:1001`，ESP32-C3，16 MB，原生 USB-Serial/JTAG）：面板“核对写入”在端口租约内确认活动槽 `ota_1 @ 0x700000`、OTA seq 2 / state 2（VALID）、bootloader IDF v5.4、app IDF 5.4.1；预览显示设备、目标槽、app SHA 前缀与擦除范围。
- 写入：面板内显式“烧录已验证 app”，不跳通用部署对话框、不再次构建、不隐式保存；app-only 单一 app 段，擦除/写入窗口 `0x700000`–`0x731FFF`（204,800 字节），写入 203,232 字节；私有快照与 journal 的 app SHA 与仿真一致；部署计划摘要 `fd3b88251453d603c58d5bb850b496d169339454c94e06dea00a6a5fd66fda7d`。
- 实机挑战：写入后新开串口会话（session #2，USB-Serial/JTAG），挑战通过并绑定上述部署摘要；app SHA 与计划摘要均由宿主复核。
- 拒绝路径（真实应用/宿主，均在写入前零写入拒绝）：Monaco 未保存编辑；“核对写入”后外部修改工程输入；构建产物被替换；串口被监视器占用；取消预览后旧 token；错误端口提交；不带宿主内部标记的通用 `esp.upload` 未消耗专用预览；已使用 token 重放。写入任务与显式流程中构建任务计数保持为 1。
- 常规面板检查：没有完整 64 位 SHA、QEMU 工具路径/版本、PID、挑战/响应值、原始日志/命令或兼容架构说明；渲染进程无错误。完整证据留在宿主 `qemu-evidence.json`、`esp-journal/` 和任务日志。
- 本结果只覆盖这一台专用测试板、这一个 ESP-IDF 示例和 ESP32-C3 的 UART0/USB-Serial-JTAG 通路；QEMU 不模拟 USB，也不代表其他板型、其他固件或电路电气行为。
