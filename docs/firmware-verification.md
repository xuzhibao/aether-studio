# 固件验证：真实 QEMU 与实机挑战（beta.10）

本文件说明产品内的 **Firmware Verification（固件验证）** 面板：它用一个真实、可复验的 ESP32-C3 示例，把“已仿真”“预检通过”“上传完成”“实机行为通过”四个阶段分开记录，避免把构建成功、退出码 0 或旧仿真记录当成设备在运行。

## 范围

- 示例工程：`examples/esp32c3-firmware-validation`，ESP-IDF 5.4.1，PlatformIO 环境 `esp32c3-qemu-uart0`。
- 仿真器：Espressif 官方 `qemu-system-riscv32`，`-machine esp32c3`，UART0 作为串口，运行由真实构建产物组装的私有 flash 镜像。
- 实机：ESP32-C3，应用只写入设备当前活动 OTA 槽（本示例约定 `ota_1 @ 0x700000`）内的单一 app 段；不写 bootloader、分区表、otadata、phy_init、`model` 或 `ota_0`。
- 已实测操作系统：Windows 10（x64）。Linux/macOS 未实测。

这**不是**电路电气仿真，也不代表所有固件、所有 ESP32 型号或所有开发板。QEMU 的 `esp32c3` 机器没有 USB 外设，因此只验证 UART0；原生 USB-Serial/JTAG 只在实体板上验证。

## 产品流程

面板以四个独立阶段驱动，每一步都有可观察的真实结果：

1. **保存并构建**：使用当前 PlatformIO 环境执行真实 `platformio run`；构建记录写入工程 `.aether/build.json`，包含所选环境、输入指纹、产物路径/大小/SHA-256。
2. **真实 QEMU 验证**：宿主读取成功的构建记录，复验 `firmware.bin`、`bootloader.bin`、`partitions.bin` 的大小与 SHA-256，确认工程输入指纹未变化，组装 QEMU 私有 flash 副本并再次校验镜像内的 app/bootloader/分区表三段；随后启动真实 QEMU。每次启动的挑战 token 由宿主新生成，响应由 `shared/firmwareValidation.ts` 的纯状态机判定。默认两次启动，两次的 app SHA 与固件标识必须一致。
3. **实机写入**：只使用既有部署流程（部署对话框 → 构建 → 只读预检 → `esp.upload`），由宿主把模式收窄为 app-only。写入前再次核对设备芯片、eFuse 安全状态、板上分区表、OTA 记录的活动槽、bootloader 与 app 的 IDF 版本、4KB 擦除对齐与包含关系；预检不通过不会启动写入进程。
4. **独立实机挑战**：写入成功后，宿主在所选端口新开一个串口会话，先发送 `HELLO` 要求当前通道重新发送 READY（应用可能在端口打开前就已启动），再生成新的挑战 token。只有同一会话中收到匹配的 `RESPONSE`，并且该会话晚于本次成功的 `esp.upload`、端口一致、观察到了真实输出，才标记“实机行为通过”。

## 可信证据与拒绝路径

- 仿真证据由宿主写入应用数据目录（`firmware-verification/qemu-evidence.json`），绑定 **app SHA-256、PlatformIO 环境、工程输入指纹** 与两次启动的挑战记录；渲染进程没有参数可以伪造或放宽它。
- 只有通过的记录才能“启用 app-only”；启用后宿主把该端口与环境记为一次性写入目标，部署时再核对：证据未被新验证替换、工程目录一致、环境一致、端口一致、app SHA 与私有写入快照一致、输入指纹未变化。
- 写入计划摘要（端口 + 环境 + 各段名称/偏移/大小/SHA-256）随成功的 `esp.upload` 任务保存；实机挑战必须绑定到该摘要。
- 会被拒绝而不是误判通过的场景：
  - 旧证据被新的 QEMU 运行替换，或验证后工程文件/环境/端口变化；
  - 构建产物在验证后被替换，或重建得到的 app SHA 不同；
  - 串口正被监视器、构建/上传任务或备份占用；
  - 设备无响应、拔线、READY/响应超时、token 不匹配、回答值不匹配；
  - 上传退出码为 0 但没有同镜像的仿真绑定，或实机挑战没有绑定到本次部署。

## 环境限制

- **非 ASCII 工程路径**：Windows 上 ESP-IDF/CMake 会把工程路径按系统 ANSI 代码页写入构建文件，ASCII 之外的中文路径会编译失败。实测使用同一份源码的 ASCII 路径副本；产品不绕过该限制。建议把 ESP-IDF 工程放在纯 ASCII 路径。
- QEMU 与实机串口共用宿主端口租约；同一时刻只能有一个入口使用设备。
- esptool 需要带 `pyserial` 的 Python。若自定义 `PLATFORMIO_CORE_DIR` 只包含 platforms/packages 而没有 penv，宿主会回退到 `AETHER_ESPTOOL_PYTHON`、配置的 PlatformIO CLI 所在 penv、或默认的 `~/.platformio/penv`。
- 面板不提供“忽略检查”“整片擦除”“写入完整镜像”按钮。

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
- 工具：PlatformIO Core 6.1.19、ESP-IDF 5.4.1、Espressif QEMU `9.2.2 (esp_develop_9.2.2_20260417)`、esptool 4.8.9。
- 工程：`examples/esp32c3-firmware-validation` 的 ASCII 路径副本，环境 `esp32c3-qemu-uart0`。
- 构建：`firmware.bin` 200,928 字节，SHA-256 `c3c87da8e89a36a540271309514a0aaebe9f2e93bba40e5fe8e68d2fb25f208d`；`bootloader.bin` 20,832 字节；`partitions.bin` 3,072 字节。
- QEMU：同一 app 两次独立启动，每次新随机挑战通过，固件标识 `aether-c3-fwval-1` 一致；返回的 app SHA 与构建产物一致。
- 实机（COM4，ESP32-C3 rev v0.4，16MB，原生 USB-Serial/JTAG）：只读预检确认活动槽 `ota_1 @ 0x700000`、OTA seq 2 / state 2（VALID）、bootloader IDF v5.4、app IDF 5.4.1。
- 写入：app-only，单一 app 段，擦除/写入窗口 `0x700000`–`0x731FFF`（204,800 字节）；esptool 写入 200,928 字节并校验哈希；任务的实际写入段与预检计划一致；写入的 app SHA 与仿真记录一致；部署计划摘要 `ba8469e37eced2068c856662fd37e73ee3908d12294edbe1678518ac635cb56c`。
- 实机挑战：写入后新开会话（session #1），挑战 `b679e28c0e891a64`，设备返回 `b2aa395c`，与宿主重算一致，并绑定上述部署摘要。
- 拒绝路径（真实 QEMU）：运行中取消记为失败且无残留进程；验证后修改工程文件导致证据失效；app SHA / 环境 / 端口不匹配被宿主拒绝；端口被其他持有者占用时实机挑战在打开端口前被拒绝。
