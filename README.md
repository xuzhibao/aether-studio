# Aether Studio

Aether Studio 是一个开源硬件开发工作区，使用 Electron、React、TypeScript 和 Monaco。它提供电路画布、文本编辑器、磁盘工程、构建任务、串口和 WebSocket 监视器，以及可配置的 AI 工程助手。

**万物皆插件**：宿主提供窗口、文件访问、任务与资源管理、事件和 UI 扩展入口；开发板、元器件、编辑器、工具链、部署、仿真和 AI 通过插件注册。官方功能也使用同一注册表。

## 当前功能

- 保留 macOS 风格布局、电路画布、Monaco、命令面板和 Agent 面板。
- 插件启停、依赖检查、事件、设置，以及命令、菜单和面板贡献。
- 打开真实工程目录，编辑 UTF-8 文本、新建文件、保存、检测外部变更和重启后重开。
- PlatformIO C++ 工程构建：实际进程、实时日志、退出码、取消任务和子进程清理。
- 构建成功后记录已加载工程文本快照 SHA-256、PlatformIO 版本、产物路径、大小和校验和。
- PlatformIO 部署插件：明确填写端口后，运行实际构建及上传命令。不会因为打开串口而显示烧录成功。
- ESP32-S3 C++ 模板，以及 MicroPython 电路演示模板。
- 原生串口与 WebSocket 字节通信；设备输出与 Demo Simulation 分开显示。
- `.aether` 工程导入导出、面板布局和编辑设置保存。
- 可配置的 Chat Completions API、工程读取工具、文件修改建议预览、应用、拒绝和请求取消。

**Demo Simulation 只生成演示数据，不执行 Python、不验证电气接线、不连接真实硬件。** C++ 模板不绑定演示仿真器。构建成功不代表已烧录，上传成功应以实际任务结果为准。

## 安装与启动

需要 Node.js 22 或更新版本：

```bash
npm ci
npm run desktop
```

桌面开发命令会编译主进程并启动 Vite。修改主进程或 preload 后需重启此命令。浏览器预览：

```bash
npm run dev
```

打开 `http://127.0.0.1:1420`。浏览器保留工作区、工程文件和演示能力，不能调用桌面文件系统、串口或本地构建。

构建未安装的桌面应用目录：

```bash
npm run desktop:package
```

输出位于 `release/`。此命令包含前端、主进程、第三方许可收集及 Electron 打包。当前不生成签名安装器或自动更新包。

## 配置 PlatformIO

PlatformIO Core 由用户安装，Aether 不捆绑编译器、芯片 SDK 或目标固件。首次构建需要下载工程声明的平台和工具包。

Linux / macOS：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install platformio==6.1.19
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" npm run desktop
```

Windows PowerShell：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install platformio==6.1.19
$env:AETHER_PLATFORMIO_CLI = (Resolve-Path .\.venv\Scripts\platformio.exe).Path
npm run desktop
```

如果 `platformio` 已在应用进程的 PATH 中，可以直接启动。`AETHER_PLATFORMIO_CLI` 指定完整可执行文件路径，不接受 shell 命令串。找不到工具或构建失败时显示实际错误。

## 磁盘工程

工程菜单或命令面板提供：

- **Open project folder**：打开已有目录，快捷键 `Ctrl+Alt+O` / `⌘⌥O`。
- **Save project to folder**：将当前工作区写入空目录，不覆盖已有目录内容。
- **Reload folder (discard unsaved edits)**：重新读取磁盘，放弃当前未保存缓冲区。

打开普通 PlatformIO 目录时不执行工程脚本；点击构建或上传才执行工具及工程配置中的构建脚本。请只构建可信工程。

目录中的普通源文件保持原有路径。Aether 元数据保存在 `aether.project.json`，电路定义保存在 `hardware/circuit.json`。界面的 `circuit.json` 是电路的只读视图，不能作为独立源文件创建；打开目录时若根目录已有同名文件，需要先重命名。

保存使用外部变更检查和逐文件临时写入。文件被外部修改后，Aether 拒绝覆盖；可重新读取目录，或将当前缓冲区另存到空目录。保存不是整个工程的文件系统事务，异常中断后不要直接删除 `.aether-saving` 文件，应先检查其中内容。

当前加载不超过 1 MiB 的 UTF-8 文本文件，跳过链接、二进制和工具缓存目录，包括 `.git`、`.pio`、`.aether`、`node_modules`、`build`、`dist`、`target`、`release`。未加载的文件不会被保存操作删除或改写。尚未提供重命名、删除、外部编辑自动合并或多根工作区。

磁盘工程源码以文件系统为准；`localStorage` 用于浏览器工作区和界面偏好。桌面最近打开目录记录在应用用户数据目录，重启时重新读取文件。可通过 `AETHER_USER_DATA_DIR` 指定用户数据位置。

## 构建与上传

在 **Plugins** 启用 PlatformIO，然后创建 **ESP32-S3 C++** 模板，或打开现有 `platformio.ini` 工程。新建模板需先 **Save project to folder**。

点击 **Build**，或在左侧 **Build Tasks** 中选择 **Build with PlatformIO**。任务运行前保存工程文件，并断开设备通信。运行期间可以编辑缓冲区，但需等待或取消任务后再保存；下次构建才会使用这些编辑。

最近成功任务保存在 `.aether/build.json`，包含已加载文本与元数据的快照指纹、工具版本、日志和产物校验和。构建前后若已加载的磁盘输入发生变化，不登记产物。此前成功任务的记录不代表当前未保存缓冲区已经构建。

上传时点击 **Deploy to Device**，选择 **PlatformIO Upload** 并明确填写端口。插件执行 `platformio run --target upload --upload-port PORT`，由工程配置决定芯片、构建和烧录方式。上传会修改设备固件；监视器先断开，完成后需手动重新连接。MicroPython 文件部署尚未接入。

不连接硬件也可打开 `examples/platformio-native`，使用本机 GCC 构建一个真实 C++ 可执行文件。`examples/platformio-esp32s3` 提供固定平台版本的 ESP32-S3 Arduino 示例。

## 设备通信

打开 **Devices**，选择通信插件及地址。原生串口支持手动路径、端口枚举、波特率、8N1 和无流控。WebSocket 支持 `ws://`、`wss://`，接收文本及二进制帧，发送携带 UTF-8 文本的二进制帧。

**Serial Monitor** 的 **Device transport** 显示实际接收数据，支持筛选、暂停显示、清空及换行选择。暂停显示不暂停接收。串口 TX 表示本地写入完成；WebSocket TX 表示进入发送队列，均不代表设备已执行命令。当前一次只连接一个设备或服务。

停用插件、切换工程或执行构建会断开通信。打开端口不识别开发板或固件；部分开发板可能因打开端口时控制线变化而复位。Linux 用户需要端口访问权限。

## AI

在 Plugins 配置 **OpenAI Compatible API** 的完整 Chat Completions URL、模型和 API Key。地址和模型保存到本地，Key 仅保留在当前会话。请求直接从渲染进程发出，服务需要允许对应来源的跨域访问；AI 服务不是 IDE 的必选依赖。

普通问答发送当前工程上下文；**Project Tools** 按模型请求读取文件或电路，并生成文件修改建议。修改须预览后应用，应用后仍需保存。文件改变后禁止用过期建议覆盖。Agent 不自动构建、上传或执行硬件操作。

## 插件开发

`src/plugins/api.ts` 定义 Manifest 和能力接口，`src/plugins/registry.ts` 管理注册、依赖、启停和清理。当前官方前端插件由 `src/plugins/builtin/index.tsx` 静态导入，运行在可信应用进程内。

插件通过 `api.register(kind, contribution)` 提供开发板、元器件、编辑器、工具链、部署、仿真器、通信、模型、Agent、工具、模板、命令、工程格式、菜单、面板和叠加视图。操作时使用 `api.project.get()` 读取当前工程；事件订阅在停用时移除。

例如，在内置插件目录新增：

```ts
import type { StudioPlugin } from "../api";
export const hello: StudioPlugin = {
  manifest: { id: "example.hello", name: "Hello", version: "0.1.0", type: "workspace", entry: "builtin/hello.ts", enabled: true, description: "输出当前工程名称。" },
  activate(api) {
    api.register("commands", {
      id: "hello.project", name: "Hello project",
      run: () => api.host.log(api.project.get().project.name),
    });
  },
};
```

将插件加入 `builtinPlugins` 数组后，可在命令面板运行，停用后命令被移除。

桌面受限 API 定义在 `shared/desktop.ts`，preload 只暴露指定操作，不暴露 Node、任意 IPC 或任意 shell 执行。后台任务只能调用已注册提供者。PlatformIO 的后台命令和产物发现位于 `desktop/plugins/platformio.ts`，串口适配位于 `desktop/plugins/serial.ts`。

当前还没有本地插件包安装器、独立插件进程、完整沙箱和插件市场。前后端注册入口仍随应用构建，不宣称支持不可信外部插件。

## 检查

```bash
npm run typecheck
npm run smoke
npm run smoke:network
npm run build
npm run build:desktop
```

真实文件和构建检查需要 PlatformIO：

```bash
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" npm run smoke:host
```

浏览器检查：

```bash
npx playwright install chromium
npm run smoke:ui
```

桌面检查需要图形会话、Python 和 PlatformIO：

```bash
npm run desktop:package
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" npm run smoke:desktop
```

Linux CI 使用 Xvfb 运行打包后的应用。测试仅替换系统文件选择器的选择结果；文件读写、任务、编译、系统虚拟串口和本地 WebSocket 收发实际执行。AI 使用明确标记的 HTTP 测试响应，没有在线模型或真实开发板验证。

## 许可与限制

Aether 原创代码采用 Apache-2.0，见 `LICENSE` 和 `NOTICE`。第三方组件保留原许可。`npm run licenses` 收集当前安装依赖及 Electron/Chromium 的许可，生成 `THIRD_PARTY_NOTICES.md` 和随桌面包分发的 `dist-licenses/`。该清单不等于对任意工程 SDK、模型权重和二进制附件的完整审计。

PlatformIO Core 使用 Apache-2.0；其下载的开发平台、编译器和 SDK 按各自许可提供。IDE 不要求商业模拟器、账号或付费模型。支持 ESP32 不代表其无线固件依赖全部提供源码。

当前尚未提供 LSP、DAP 调试、交互式 PTY 终端、Git 面板、真实固件仿真、MicroPython 设备文件管理、外部插件安装、签名安装器和自动更新。电路画布不提供电气正确性保证。真实设备上传及 macOS/Windows 桌面运行需要对应环境验证。
