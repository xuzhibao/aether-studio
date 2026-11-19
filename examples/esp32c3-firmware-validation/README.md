# ESP32-C3 固件验证示例（真实串口闭环）

用一个真实镜像证明两件事，而不是让宿主自己打印“通过”：

1. 相同 `firmware.bin` 启动后给出确定标识（同一镜像多次启动，标识逐字节相同）。
2. 对本轮宿主随机生成的挑战返回与输入对应的应用计算，且回包准确绑定新挑战与当前运行阶段。

判定完全由 `shared/firmwareValidation.ts`（纯函数，无 I/O）完成；不匹配、超时、断连都会记为失败，不会因为“看到过某条历史启动日志”而判通过。

## 边界

- 挑战路径纯内存：不写 NVS、GPIO、Flash，不联网。
- 应用不访问分区表、不做 OTA、不初始化 WiFi/BT。
- 本示例构建出的 `bootloader.bin` / `partitions.bin` / 合并镜像只用于 QEMU 与已核对的测试板。
  厂商 16 MB 分区设备只接收 **app-only `firmware.bin`**，写入位置由设备侧预检决定（本仓库约定为 `ota_1@0x700000`），并且必须由设备所有者授权后执行。
- 本分支的验证不接触实体板与 COM 端口。

## 文件

```
examples/esp32c3-firmware-validation/
  platformio.ini                 PlatformIO 工程（ESP-IDF 5.4.1，16 MB，设备同款分区表）
  sdkconfig.defaults             IDF 配置（UART0 console、16 MB flash、自定义分区表）
  CMakeLists.txt, src/           固件：协议主循环 + 纯 C 协议核心
  partitions.vendor.csv          设备实板分区表（只读 dump 核对；不写入设备）
  tools/build-qemu-image.mjs     真实 PlatformIO 构建 + 合并 16 MB QEMU 镜像 + 记录 SHA
  tools/validate.ts              QEMU / 物理串口的真实挑战-响应运行器
  tools/matcher.test.ts          纯模块单元测试（分片、陈旧 token、超时、断连等）
  .gitignore                     构建产物与生成的 sdkconfig
shared/firmwareValidation.ts     共享纯模块：行流式解析、有界匹配、记录字段
```

## 协议

行式、可打印 ASCII、`\n` 或 `\r\n` 结尾，单条协议行 ≤ 128 字节。设备与宿主都必须能处理任意分片（一次读取里可能只有半个 token，也可能一次收到多行）。

设备 → 宿主（启动后立即发送；USB 主机在启动后才连接时，在连接建立时为该次连接再发送一次。每次连接只发送一次）：

```
AETHER-VAL/1 READY fw=aether-c3-fwval-1 proto=1 soc=esp32c3 console=uart0
```

`console` 的值取决于回包通道：UART0 为 `uart0`，USB-Serial/JTAG 为 `usb-serial-jtag`。

宿主 → 设备（可选，要求当前通道重新发送 READY；用于宿主在启动后才连接串口的场景）：

```
HELLO
```

宿主 → 设备（每轮新随机 token，16 位小写十六进制）：

```
CHALLENGE token=0123456789abcdef
```

设备 → 宿主：

```
AETHER-VAL/1 RESPONSE token=0123456789abcdef value=f0c11dd7 fw=aether-c3-fwval-1
AETHER-VAL/1 ERROR code=bad-command
```

`ERROR` 的 code 为 `bad-command`、`bad-token`、`line-too-long` 之一。设备收到错误命令不会静默。

### 应用计算（两侧必须一致）

```
h = FNV-1a32(ASCII(token))
k = FNV-1a32(ASCII(fwid))
x = (h XOR k)
x ^= x >> 16; x = (x * 0x7feb352d) mod 2^32
x ^= x >> 15; x = (x * 0x846ca68b) mod 2^32
x ^= x >> 16
value = 8 位小写十六进制
```

- C 实现：`src/fwval_core.c`（不依赖 ESP-IDF，可在宿主编译）。
- TS 实现：`shared/firmwareValidation.ts` 的 `fwvalAnswer`。
- 两侧用宿主 gcc 交叉验证同一组向量（见“本轮证据”）。

## 传输：一个镜像，两条真实通道

- **UART0 是 console，也是 QEMU 暴露的串口。** QEMU 的 `esp32c3` 机器没有 USB 外设。
- **同一镜像**在 UART0 就绪后尽力启动原生 USB-Serial/JTAG 驱动；它是独立、非阻塞的旁路：
  - 驱动不可用或外设缺失时只打印一条日志，UART0 与协议循环继续工作；
  - 读取/写入都带 0–20 ms 超时，不会因为主机关闭端口而卡死；
  - 回包发回发起请求的那条通道。
- 真机若以原生 USB-Serial/JTAG 枚举（VID 303A:1001），烧录后 COM 号可能变化；监视端必须重新枚举、按 VID/PID 或端口路径绑定，不能固定旧 COM 号。

## 构建

```powershell
# 依赖：PlatformIO Core 6.1.19；首次使用会下载 ESP-IDF 5.4.1 与工具链。
pio run -e esp32c3-qemu-uart0

# 生成 QEMU 镜像并记录版本与 SHA（PlatformIO + esptool 真实调用）
node examples/esp32c3-firmware-validation/tools/build-qemu-image.mjs
```

`build-qemu-image.mjs` 会：

1. 运行 `pio run`（不是手工调用编译器）；
2. 用 esptool `merge_bin` 生成 16 MB 的 `flash-qemu.bin`（bootloader 0x0、分区表 0x8000、app 0x100000 = `ota_0`）；
3. 输出 `firmware.bin` 与合并镜像的大小、SHA-256，以及 PlatformIO / Python / esptool 版本。

环境约束（Windows，本机实测）：

- 磁盘紧张时可用 `PLATFORMIO_CORE_DIR`、`PLATFORMIO_BUILD_DIR`、`TMP`/`TEMP` 把包和构建目录放到其他盘。
- 项目路径含非 ASCII 字符时，CMake 会按系统 ANSI 代码页把路径写进 `build.ninja`，平台脚本按 UTF-8 读取会报 `UnicodeDecodeError`。本轮构建因此使用同一份源码的 ASCII 路径副本（构建前用 SHA-256 清单确认逐文件一致）。

## QEMU 验证

```powershell
node --import tsx examples/esp32c3-firmware-validation/tools/validate.ts `
  --image examples/esp32c3-firmware-validation/.pio/build/esp32c3-qemu-uart0/flash-qemu.bin `
  --firmware examples/esp32c3-firmware-validation/.pio/build/esp32c3-qemu-uart0/firmware.bin `
  --qemu S:\aether-qemu\qemu-9.2.2\bin\qemu-system-riscv32.exe `
  --boots 2 --expect-fw aether-c3-fwval-1
```

QEMU 参数（与既有硬件实验约定一致）：

```
-M esp32c3 -nographic -monitor none -serial stdio -icount 3
-drive file=<flash.bin>,format=raw,if=mtd
-global driver=timer.esp32c3.timg,property=wdt_disable,value=true
```

运行器会把镜像复制到系统临时目录再启动，调用方给的镜像本身不会被 QEMU 的 otadata 写入改动。

约束与缺项：

- Windows 版 QEMU 打不开含非 ASCII 字符的路径（ROM 数据目录与镜像路径都受影响）。`--qemu` 必须指向 ASCII 路径的安装。
- 本仓库内置的 `espressif32@6.12.0`（Arduino 2.0.17 / IDF 4.4.7）在该 QEMU 上会在 flash 初始化处 assert，不能用于本验证；因此本示例使用 pioarduino 54.03.20 的 ESP-IDF 5.4.1。

## 物理串口验证

```powershell
node --import tsx examples/esp32c3-firmware-validation/tools/validate.ts `
  --port COM5 --transport usb-serial-jtag --boots 1 --expect-fw aether-c3-fwval-1
```

硬件模式复用同一个 `FwValSession`，记录中 `transport`/`evidence` 会标为 `hardware`。**本轮未接触实体板，硬件模式未在本机验证**；它属于交付给 C 的同一判定路径，不是已完成的实机证据。

## 记录字段（供 A/C/D 调用）

每次运行产出一个 `FwValRecord`（JSON）：

| 字段 | 含义 |
| --- | --- |
| `protocol` | 固定 `AETHER-VAL/1` |
| `runId` | 本次运行 ID（宿主生成） |
| `transport` | `qemu-uart0` / `uart0` / `usb-serial-jtag` |
| `evidence` | `virtual`（QEMU）或 `hardware`；A/C/D 不得混用 |
| `phase` | 结束阶段：`awaiting-ready` / `ready` / `challenge-issued` / `passed` / `failed` |
| `verdict` | `pass` / `fail` / `incomplete` |
| `startedAtMs`, `finishedAtMs` | 宿主时间戳；超时判定基于它们 |
| `challenge.token`, `challenge.issuedAtMs` | 本轮新挑战及其下发时刻 |
| `device` | READY 解析出的 `fw` / `proto` / `soc` / `console` |
| `response` | 设备回包原文 `token` / `value` / `fw` |
| `expectedValue` | 宿主独立计算的期望值 |
| `failure.code`, `failure.detail` | 失败原因（见下表） |
| `bytesIn`, `linesSeen`, `ignoredLines` | 收到的字节/行数与被忽略的非协议行（启动日志）计数 |

失败码：`ready-timeout`、`response-timeout`、`disconnected`、`protocol-error`、`line-too-long`、`response-before-ready`、`reboot-detected`、`stale-token`、`value-mismatch`、`fwid-mismatch`、`bad-token`、`device-error`。

只有 `verdict === "pass"` 才算通过；`incomplete` 不是通过。

## 厂商 16 MB 设备（app-only）

- 目标槽：设备实板 dump 确认的活动槽 `ota_1@0x700000`；`board_upload.offset_address = 0x700000`。
- 应用 IDF 版本必须与设备 bootloader 的 major.minor 相等（设备 bootloader v5.4；本构建 IDF 5.4.1）。
- `partitions.vendor.csv` 与设备 0x8000 处分区表逐字节一致（由设备侧只读 dump 核对），构建出的 `partitions.bin` 覆盖 `ota_1`，仅供预检比对，**不写入设备**。
- 禁止写入：bootloader、分区表、otadata、phy_init、model、ota_0、nvs、`boot_app0@0xE000`。
- 设备写入需要用户对精确范围的授权；本轮零写入。

## 本轮证据（2026-11-19，QEMU 虚拟）

工具版本：

- PlatformIO Core 6.1.19；platform `pioarduino/espressif32` 54.3.20；`framework-espidf` 3.50401.0（ESP-IDF 5.4.1）
- esptool.py 4.8.9；toolchain-riscv32-esp 14.2.0+20241119
- QEMU 9.2.2（`esp_develop_9.2.2_20260417`，`-M esp32c3`）
- 宿主 gcc 15.1.0（仅用于 C 纯核心交叉验证）

构建产物：

- `firmware.bin`：200,848 字节，
  SHA-256 `40d10dc291c0482a6e88840c24af78c60f1b97f5e56479f8f0a8ce49390d2a70`
- `flash-qemu.bin`（16 MB，QEMU 专用）：16,777,216 字节，
  SHA-256 `d0bf57095a0b20f0a14fbbfb50880ad9893afba13e0da8242eaaf2cc5c44d82d`
- 应用描述符：`ESP-IDF: 5.4.1`，Chip ID 5 (ESP32-C3)，Flash size 16MB，DIO/80m
- 构建出的 `partitions.bin` 解析结果与设备实板一致：
  `nvs 0x9000/16K`、`otadata 0xD000/8K`、`phy_init 0xF000/4K`、`model 0x10000/960K`、`ota_0 0x100000/6M`、`ota_1 0x700000/6M`

QEMU 闭环（同一 `firmware.bin`，两次独立启动）：

| run | 挑战 token | 设备回包 value | 宿主期望 | 结果 |
| --- | --- | --- | --- | --- |
| qemu-0f28b6e6 | `c8d0131d9a1a7fcc` | `ccf1b23d` | `ccf1b23d` | pass |
| qemu-1b7f5b3c | `314a97c03b7f6f3d` | `41a2c277` | `41a2c277` | pass |

两次 READY 标识完全一致（`identityStable: true`），每次忽略 58 行启动日志；`verdict: pass`。

C/TS 纯计算交叉验证（宿主 gcc 15.1.0 vs TS 实现）：

| token | value |
| --- | --- |
| `0123456789abcdef` | `f0c11dd7` |
| `fedcba9876543210` | `eed378b8` |
| `a1b2c3d4e5f60718` | `66a05072` |

共享纯模块单元测试：14/14 通过（分片、CRLF、陈旧 token、错误 value、超时、断连、重复 READY、挑战中同标识 READY、身份变化、超长行、身份不匹配、设备 ERROR、硬件 evidence 标记）。

未验证（如实记录）：

- 未在实体 ESP32-C3 上运行；未打开任何 COM 端口。
- USB-Serial/JTAG 旁路只在 QEMU（无 USB 外设）中验证了“可安装、不阻塞、UART0 不受影响”，未在真机 USB 上验证收发。
- 设备写入、擦除范围与部署由 C 在用户授权后执行。
