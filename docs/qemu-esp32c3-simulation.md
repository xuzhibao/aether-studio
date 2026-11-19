# ESP32-C3 QEMU 固件运行（beta.10 · A 线）

本文件记录宿主机侧 QEMU 模拟器的真实工具安装、实测命令、镜像布局边界、宿主模块接口与验收结果。
模拟对象是 Espressif 官方 QEMU 运行的真实 ESP32-C3 固件，不是 Demo simulator 的假 tick，也不是替身 CLI。

## 1. 工具来源与安装

- 上游：`https://github.com/espressif/qemu`
- Release：`esp-develop-9.2.2-20261109`（发布于 2026-11-09）
- 本项目实测资产：`qemu-riscv32-softmmu-esp_develop_9.2.2_20261109-x86_64-w64-mingw32.tar.xz`
  - 大小：39,817,984 字节
  - 官方 SHA-256（`qemu-esp_develop_9.2.2_20261109-checksum.sha256`）：
    `2ad104a99f4db4ec16faf016910562738522b0b63d9ab485358e8f6f95604708`
  - 本机 `sha256sum` 实测同值，已核对。
- 许可证：QEMU 主体为 GNU GPL v2（Release 内 `LICENSE`、上游 `COPYING`）。Aether Studio 不随应用分发 QEMU；它作为用户本机工具，按 `ToolService` 的可信路径运行。
- 隔离安装位置（不在仓库内）：
  `C:\Users\Bao\.aether-tools\qemu-esp32c3-9.2.2\qemu\bin\qemu-system-riscv32.exe`
- 支持的机型由真实 `-machine help` 确认，包含 `esp32c3`（以及 C5/C6/C61/H2/H4/P4 等）；上游 QEMU 没有 ESP32 机型，因此只接受 Espressif 构建。

实测：

```text
> qemu-system-riscv32.exe --version
QEMU emulator version 9.2.2 (esp_develop_9.2.2_20261109)

> qemu-system-riscv32.exe -machine help
Supported machines are:
esp32c3              Espressif ESP32-C3 machine
esp32c5              Espressif ESP32-C5 machine
...
```

QEMU 源码 `hw/riscv/esp32c3.c` 只接受 2/4/8/16MB 的 `-drive if=mtd` 镜像；镜像大小由构建出的分区表末端向上取整到这四个容量之一，不写死常量。

## 2. 真实构建与启动证据

构建链（真实安装）：

- PlatformIO Core 6.1.19
- `platform = espressif32@6.12.0`
- Arduino-ESP32 `3.20017.241212+sha.dcc1105b`
- `board = esp32-c3-devkitm-1`，4MB flash，QIO

生产示例 `examples/platformio-esp32c3`（原生 USB CDC）真实构建后，由宿主模块组装私有 flash 并启动。
最近一次完整验收的实际值（每次构建的应用 SHA 会因镜像内嵌时间戳而不同，记录值是当次真实值）：

- 生产 app `firmware.bin`：256,112 字节，SHA-256
  `3e0eca067510e3678b0ed5e2b836231eafc4d44bf75d023f36d2b65be8856a89`
- QEMU 私有 flash：4,194,304 字节，SHA-256
  `a223026e9b5e1352a79fbfa286711789292c07821accb7e9f19eb4b1e2abc1cd`
- UART0（stdout）关键行：
  `ESP-ROM:esp32c3-api1-20210207`、`load:0x403cc710,len:0x90c`、`entry 0x403cc710`

UART0 探针（验收专用、与生产固件不同的另一份二进制）：

- app `firmware.bin`：258,896 字节，SHA-256
  `f75d75737cf2e9c699895d9b53f739cfebe6b8c39e5a4ea61222ddf49add526d`
- 真实 UART 行：`AETHER-QEMU-UART-PROBE`（约 1 秒一行）
- 探针源码在验收脚本运行时临时生成，构建完成后连同临时目录移到回收站，不进入仓库。

启动 argv 固定为（`shell: false`，不接受任何用户追加参数）：

```text
qemu-system-riscv32
  -display none -serial stdio -monitor none
  -machine esp32c3
  -drive file=<私有临时目录>/flash.bin,if=mtd,format=raw
```

`-serial stdio` 的 stdout 是 UART0；stderr 是 QEMU 自身诊断（例如 `Adding SPI flash device`），宿主模块分通道保存、分别有界。

## 3. QEMU 镜像与物理板布局的边界

- QEMU 使用的是**私有临时 flash 副本**，只在模拟器生命周期内存在，永不用于实板烧录。
- 合并地址来自被支持的构建计划，而不是通用猜测：
  - bootloader：ESP32-C3 ROM 从 `0x0` 读取（构建出的 `bootloader.bin` 首字节必须为 `0xE9`）；
  - 分区表：`0x8000`（ESP-IDF `PARTITION_TABLE_OFFSET` 默认值；PlatformIO 平台源码同值）；
  - app：从该工程真实 `partitions.bin` 解析出的 `ota_0`（否则 `factory`）分区偏移。生产示例当前是 `0x10000`。
- QEMU flash 容量由 `partitions.bin` 声明的最大末端决定，取 2/4/8/16MB 中最小可容纳值。
- 应用 payload 是构建出的 `firmware.bin` **逐字节副本**；镜像组装后再次校验 app/bootloader/分区表三段的 SHA-256，快照里明确给出 `app.sha256`。
- 物理板布局（由 B/C 只读取证确认）：ESP32-C3 rev v0.4、16MB flash；`0x10000` 为厂商模型区；设备分区表含 `ota_0 @ 0x100000`、`ota_1 @ 0x700000`（各 6MB，data 0x82 区 0x10000/0xF0000）；otadata 0xD000 两条记录均 VALID，较大 seq 指向 `ota_1`，即活动槽为 `0x700000`。设备 bootloader 为 IDF v5.4，物理写入必须 app-only，app 的 IDF major.minor 必须为 5.4。
  - 本轮**没有**把 QEMU 合并镜像或 `0x10000` 布局用于物理板，也没有访问 COM4 或任何实体串口。
  - QEMU 私有 flash 的 otadata 是擦除态，bootloader 因此选择表内的 `ota_0`（存在则优先；否则 `factory`）。这只是模拟器的私有启动选择；物理 `ota_1 @ 0x700000` 的写入完全由 C 部署线负责，A 不写任何设备分区。
  - 当前 `examples/platformio-esp32c3` 使用 Arduino-ESP32 2.0.17（IDF 4.4.7），只能作为工具链探针，不能作为物理应用；B 需要提供 IDF 5.4.x 的生产构建。
  - 后续接入 B 分支 `examples/esp32c3-firmware-validation` 时，模块按该工程真实 `partitions.bin` 解析 app 偏移；只要构建记录包含同一次构建的 `bootloader.bin`、`partitions.bin`、`firmware.bin`，QEMU 就会用与物理部署**逐字节相同**的 app payload 启动。纯 ESP-IDF（非 PlatformIO）工程需要额外适配构建记录格式，模块当前只消费 `platformio.build`。
  - 本轮用**同族 16MB 布局探针**实测通过：`partitions.csv` 含 `model @0x10000/0xF0000`、`ota_0 @0x100000/6MB`、`ota_1 @0x700000/6MB`；模块生成 16,777,216 字节私有 flash，解析出 app 偏移 `0x100000`，保留 `ota_1` 槽，UART0 输出 `AETHER-QEMU-LAYOUT-16MB`。探针不是生产固件，也没有写设备。
- 原生 USB CDC（`ARDUINO_USB_MODE=1`、`ARDUINO_USB_CDC_ON_BOOT=1`）在 QEMU 中没有可用的 USB Serial/JTAG 通道：实测即使 `-machine esp32c3,usb=on` 也只有 ROM/bootloader 的 UART0 输出，没有应用层 USB CDC 行。这不是失败，而是虚拟外设边界；应用层 UART 验证使用独立的 UART0 探针，绝不把探针称作生产固件。

## 4. 宿主模块接口（`desktop/simulator/qemu.ts`）

只新增模块，未改 `desktop/main.ts`、`preload.ts`、`shared/`、版本号与现有 UI。集成方按下述接口接入：

```ts
import { createQemuSimulator, qemuEsp32c3Tool } from "./simulator/qemu";

tools.define(qemuEsp32c3Tool); // id: qemu-esp32c3；env: AETHER_QEMU_RISCV32；versionArgs: --version

const simulator = createQemuSimulator({
  tools,                                  // 现有 ToolService：路径、来源、真实 --version
  workspace,                              // 现有 WorkspaceService：root 与 fingerprint()
  emit: (snapshot) => emit("simulator:changed", snapshot),
  trashItem: (target) => shell.trashItem(target), // 私有临时文件只移到回收站
});

// 显式启动（UI 只能传环境与有界超时，不能传命令/参数）：
await simulator.start({ environment: "esp32-c3", timeoutMs: 30000 });
await simulator.cancel();   // 等待 QEMU 真正退出并完成私有文件清理
simulator.snapshot();       // 最近一次快照（含真实错误）
await simulator.dispose();  // 工程切换与退出时等待进程收束；建议加入 beforeSwitch 与 before-quit
```

建议的 IPC 名称（preload 由集成线统一添加）：`simulator:start`、`simulator:cancel`、`simulator:snapshot`、事件 `simulator:changed`。

为什么不注册成 `TaskProvider`：`TaskService.start()` 会同步占用宿主唯一的串口令牌，而模拟器不碰 COM 口，也不应与串口监视器互斥；因此模块只消费 `TaskService` 写出的构建记录，把进程、日志、取消和清理留在自己的单槽生命周期里。

`SimulatorSnapshot` 关键字段：

- `status`: `running | stopped | failed`；`stopReason`: `timeout | cancel | exit`
- `pid`、`exitCode`、`error`（真实进程错误/退出码尾部）
- `root`、`environment`
- `build`: `{ recordSha256, inputHash, builtAt }`
- `app`: `{ path, sha256, size }`
- `flash`: `{ sha256, size, bootloaderOffset, partitionTableOffset, partitions[] }`
- `qemu`: `{ executable, version }`；`argv`（完整固定 argv）
- `uart`（stdout）、`diagnostics`（stderr）、`log`（合并显示）；三者均截断到 250,000 字符

与部署计划绑定时使用：`app.sha256`（物理部署与 QEMU 必须一致的 app payload）、`build.recordSha256`（授权本次运行的构建记录）、`build.inputHash`（源码/配置指纹）、`flash.sha256`（QEMU 私有镜像）与 `qemu.version`。随机挑战与串口监视会话属于串口层，不在本模块内。

### 4.1 跨端证据记录（`simulatorEvidence`）

模块导出 `simulatorEvidence(snapshot)`，按 C 的 app-only 门槛产出：

```json
{
  "version": 1,
  "passed": true,
  "appSha256": "<64 hex>",
  "environment": "esp32-c3",
  "inputHash": "<WorkspaceService.fingerprint 的 64 hex>",
  "recordedAt": "<ISO>",
  "source": {
    "kind": "qemu.esp32c3", "qemuExecutable": "...", "qemuVersion": "...",
    "buildRecordSha256": "<64 hex>", "qemuFlashSha256": "<64 hex>",
    "qemuFlashBytes": 4194304, "appBytes": 256112,
    "status": "stopped", "stopReason": "cancel", "pid": 12345
  }
}
```

- `passed` 只有同时满足“UART0 出现真实 `ESP-ROM:esp32c3`”与“进程干净停止”才为 true；提前取消或校验失败为 false。
- 跨端唯一绑定字段是 `appSha256`；QEMU 版本、构建记录 SHA、flash SHA 只放在 `source` 审计字段，不能替代 `appSha256`，也不应与 `deploymentPlanDigest` 相等。
- `inputHash` 对 `passed = true` 是**硬要求**：缺失时 `simulatorEvidence` 直接抛错，最终产品门槛不会省略它。它由宿主 `WorkspaceService.fingerprint()` 对磁盘工程计算，与 `TaskService` 写入构建记录时使用的算法完全一致。
- `recordedAt` 取真实运行结束时间（未结束则启动时间）。

### 4.2 可信记录来源

`start()` 唯一信任的工程标识来自宿主已有的成功构建记录：`TaskService` 的 `platformio.build` 在进程成功退出且输入未变化时写入 `.aether/build.json`，包含 `provider`、`status`、`root`、`environment`、`inputHash`、`startedAt` 和每个产物的 `path/size/sha256`。模拟器不自己推算工程根或环境，也不接受调用方直接传入 SHA。独立 CLI/验收脚本只是工具链证据；任何“已验证镜像”的部署门槛必须从这条宿主记录取值，root、environment、inputHash、app SHA 任一缺失或变化即拒绝。

生命周期约束：

- 同一时间只允许一个模拟器实例运行；第二次 `start` 明确拒绝。
- 超时范围 1,000–300,000ms；到点后停止并等待真实进程退出，状态 `stopped`、`stopReason: timeout`。
- `cancel()` / `dispose()` 在 `close` 事件后才返回；Windows 使用 `taskkill /PID <pid> /T /F` 收束进程树，POSIX 先 SIGTERM 后 SIGKILL。
- 私有临时目录只在 `close` 之后移到回收站；清理失败会在 `diagnostics` 里报告路径，绝不永久删除。
- 不监听端口、不联网、不复用 Demo simulator 的 `tick`。

## 5. 构建记录与 TOCTOU 校验

`start()` 只消费现有 `TaskService` 产出的 `.aether/build.json`，不自行调用 PlatformIO：

1. 要求 `provider = platformio.build`、`status = succeeded`、`root` 与当前工程一致、`environment` 与所选环境一致。
2. 读取记录中 `firmware.bin`、`bootloader.bin`、`partitions.bin`；拒绝符号链接、绝对路径、`..` 与重复文件名。
3. 校验每个产物的大小与 SHA-256 与记录一致；`workspace.fingerprint()` 必须等于记录的 `inputHash`。
4. 组装 QEMU 私有镜像后，再校验镜像内 app/bootloader/分区表三段 SHA-256；再次计算输入指纹，若变化则取消。
5. flash 副本落盘后用 `wx` 写入并重新读回校验 SHA；之后才 `spawn` QEMU。

因此“边校验边替换”最多只能替换掉之后无人使用的源文件；QEMU 读到的是已校验并复验过的内存字节/私有副本。

## 6. 真实验收脚本

```powershell
$env:AETHER_QEMU_RISCV32  = "C:\Users\Bao\.aether-tools\qemu-esp32c3-9.2.2\qemu\bin\qemu-system-riscv32.exe"
$env:AETHER_PLATFORMIO_CLI = "C:\Users\Bao\.platformio\penv\Scripts\platformio.exe"
$env:PLATFORMIO_SETTING_ENABLE_TELEMETRY = "No"
node --import tsx scripts/smoke-qemu-simulator.ts
```

脚本实际执行：

- 真实 PlatformIO 构建生产示例、UART0 探针与 16MB 布局探针（各自独立的 app 与 SHA）；
- 生产 app 真实启动，断言 ROM/entry UART0 行与 app SHA；
- 独立重算 QEMU 合并镜像 SHA，与模块快照比对；
- `simulatorEvidence` 证据记录：`passed=true`、`appSha256`、`environment`、`inputHash`、`recordedAt`、`source` 审计字段全部核对；
- UART0 探针输出真实应用行；
- 16MB 同族布局：app `@0x100000`、`ota_1 @0x700000` 保留、私有 flash 16MB；
- 超时停止、取消、运行中二次启动拒绝；
- 篡改构建记录中的 app SHA → 拒绝且 `pid = null`；
- 构建后修改源码 → 输入指纹不一致，拒绝；
- QEMU 路径缺失 → 真实定位错误；
- 每个停止场景都检查真实 PID 已不存在；
- 结束时把临时目录移到回收站。

最近一次运行结果（摘录）：

```text
[QEMU] QEMU emulator version 9.2.2 (esp_develop_9.2.2_20261109)
[通过] 证据记录：passed=true，appSha256=3e0eca06...be8856a9，environment=esp32-c3
[通过] 生产示例启动：app 3e0eca06...be8856a9，UART0 行 ... entry 0x403cc710
[通过] UART0 探针：app f75d7573...9add526d，UART 行 AETHER-QEMU-UART-PROBE
[通过] 16MB 物理同族布局：app @0x100000，ota_1 @0x700000 保留，QEMU 从 ota_0 启动，app 9f21e858...e44b58103
[通过] 超时停止并收束真实进程
[通过] 篡改构建产物 SHA 被拒绝，未启动进程
[通过] 构建后修改源码被拒绝，未启动进程
[通过] 缺失 QEMU 路径返回真实错误
PASS qemu simulator: real PlatformIO builds, real QEMU boots, verified app bytes, UART0, timeout/cancel, refusal paths; no hardware serial
```

其中生产示例当次 QEMU 私有 flash SHA-256 为 `a223026e...e2abc1cd`；生产 app 为 256,112 字节，探针 app 为 258,896 字节。

## 7. 未实测与待集成

- 非 Windows 平台（Linux/macOS）未实测；脚本的回收站清理目前只实现 Windows。
- USB Serial/JTAG 模拟未实现/未验证；原生 USB CDC 示例在 QEMU 中只有 UART0。
- B 分支 `examples/esp32c3-firmware-validation` 在本 worktree 中不存在；其真实的 IDF 5.4.x 构建尚未在本机运行。同族 16MB 布局（`ota_0 @0x100000`、`ota_1 @0x700000`）已用独立探针验证；拿到 B 的构建记录后可直接用同一模块复核 app SHA。
- 实体板、COM4、串口、烧录均未在本轮操作。
- `typecheck`：`tsc -p tsconfig.desktop.json` 与脚本单独类型检查通过。
