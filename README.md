# Aether Studio

Aether Studio 是一个使用 Tauri、React 和 TypeScript 开发的硬件开发工作区。可以在同一工作区中选择开发板、创建工程、编辑电路和代码、运行演示、保存并重开。

核心原则是 **万物皆插件（Everything is a Plugin）**。宿主提供桌面窗口、工作区、工程存储、事件和扩展入口。开发板、元器件、编辑器、工具链、仿真与 AI 服务通过同一套 TypeScript API 注册。

## 功能

- macOS 风格布局、左侧导航、中央画布、右侧 Agent、底部调试区、Monaco 编辑器和命令面板。
- 统一插件注册、启用、停用和卸载接口，依赖检查，停用时移除能力、UI 和事件订阅。
- Plugins 界面显示名称、类型、版本、入口、依赖和已注册能力，并支持启停和插件设置。
- 开发板和模板来自已启用插件。可创建空白 ESP32-S3 工程，添加、拖动、删除元器件和编辑连线。
- MicroPython 示例可编辑；Check Files 只检查入口文件非空和配置 JSON 可解析，不是真实编译。
- Demo Simulation 提供环境数据、OLED 演示帧、日志、画布读数和插件面板。
- 保存工程后，可切换工程、刷新页面或重启应用再打开，恢复电路、代码和能力绑定。
- AI 面板可调用用户配置的 OpenAI Compatible Chat Completions API。只提供问答，不自动修改或执行工程。

**Demo Simulation 使用生成数据，不执行 Python、不验证电气接线、不连接真实硬件。修改 Python 代码不会改变演示数据。**

## 启动

建议使用 Node.js 22 或更新版本。首次安装：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:1420`。

```bash
npm run typecheck
npm run smoke
npm run build
npm run preview -- --host 127.0.0.1
```

`smoke` 使用一个小脚本检查插件生命周期、依赖、工程编辑和持久化、演示输出，以及 AI 适配器的 HTTP 请求格式和错误处理。AI 检查使用测试响应，不验证真实模型服务。

浏览器端到端冒烟测试：

```bash
npx playwright install chromium
npm run build
npm run smoke:ui
```

Linux CI 可使用 `npx playwright install --with-deps chromium` 同时安装浏览器系统依赖。测试会启动独立的预览服务，操作插件界面、创建工程、添加和拖动元器件、在 Monaco 中编辑、运行演示、保存后刷新重开，并检查浏览器控制台。截图写入 `smoke-results/`。

## 桌面端

先安装 Rust stable 和 [Tauri 2 对应平台的系统依赖](https://v2.tauri.app/start/prerequisites/)。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC C++ 构建工具和 WebView2；Linux 需要 GTK/WebKit 开发库。

Ubuntu 24.04 的依赖安装示例：

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

在仓库根目录运行：

```bash
npm run tauri -- dev
```

此命令会自动启动 Vite，无需另开 `npm run dev`。构建桌面包：

```bash
npm run tauri -- build
```

GitHub Actions 的 `MVP smoke` 工作流分别检查前端端到端流程，以及 Linux 原生窗口启动和存活状态；原生窗口检查会上传截图和日志。

## 运行示例工程

1. 打开左侧 **Plugins**，确认内置插件已启用。
2. 选择 ESP32-S3 插件，点击创建工程，选择 **Blank workspace**。
3. 打开 **Components**，分别添加 **BME280** 和 **OLED**；可拖动元器件，使用 `W` 选择引脚连线。
4. 打开 `main.py` 编辑示例代码。代码中的 BME280/SSD1306 真机驱动需自行安装，本 MVP 不提供它们。
5. 点击 **Run Simulation**，在底部 **Console / Serial Monitor** 查看带有 `Demo Simulation` 标记的输出。
6. 使用 `Ctrl+S` / `⌘S` 保存。刷新页面、重启桌面端或从顶部工程菜单重新打开。

也可直接使用 **Environment monitor** 模板，获得预置电路和代码。

工程与插件设置保存到当前浏览器来源或桌面 WebView 的 `localStorage`，不会生成 `.aether` 文件。创建和切换工程时保存工作区；普通编辑需按保存快捷键。浏览器和桌面端的数据分别存储。`circuit.json` 是从画布生成的只读视图，修改电路请使用画布。

## 内置插件

| ID | 类型 | 提供的能力 |
| --- | --- | --- |
| `aether.esp32-s3` | board | ESP32-S3 DevKitC-1 定义、引脚和外观 |
| `aether.components` | components | BME280、OLED、LED、电阻等九种元器件 |
| `aether.micropython` | toolchain | 示例文件、工程文件检查、命令 |
| `aether.editor.monaco` | editor | Monaco 文本编辑器 |
| `aether.demo` | simulator | 生成数据、输出日志、画布读数、面板与菜单 |
| `aether.ai.openai` | ai-provider | 可配置的 Chat Completions HTTP 适配器和 Ask Agent |
| `aether.templates` | template | 环境监测、空白开发板工程模板 |

停用被其他已启用插件依赖的插件时，界面会提示先停用依赖者。重新启用插件会加载依赖。停用不会删除工程内容；对应能力会停止提供，画布或编辑器显示不可用提示。

## 插件如何工作

- `src/plugins/api.ts`：Manifest、Plugin API、工程上下文和贡献类型。
- `src/plugins/registry.ts`：统一注册表、生命周期、依赖、事件、设置和能力清理。
- `src/plugins/builtin/`：内置插件实现；硬件定义和绘制也在这里。
- `src/plugins/runtime.ts`：导入内置入口并注册加载。
- `src/store/studio.ts`：工作区状态、工程保存和调用已注册能力。

`entry` 是入口元数据；当前入口由 TypeScript 静态导入，不从字符串动态执行，也不扫描用户目录。插件在同一进程内运行。类型可注册多个能力，不各建一套管理系统。生命周期目前是同步 `activate(api)` 和可选的 `deactivate()`；异步 API 调用放在注册的命令或能力内。

插件可以贡献 `boards`、`components`、`editors`、`toolchains`、`simulators`、`providers`、`agents`、`templates`、`commands`、`panels`、`menus` 和画布 `overlays`。`api.project.get()` 在操作时读取当前工程，`api.capabilities.require()` 获取另一个插件的能力。`api.events` 用于工程和插件事件；通过 API 添加的订阅在插件停用时自动清理。`api.settings` 按插件 ID 保存设置，Manifest 可声明设置字段。

## 开发一个简单插件

新建 `src/plugins/builtin/hello.ts`：

```ts
import type { StudioPlugin } from "../api";

export const helloPlugin: StudioPlugin = {
  manifest: {
    id: "example.hello",
    name: "Hello Project",
    version: "0.1.0",
    type: "workspace",
    entry: "builtin/hello.ts",
    description: "读取当前工程并输出日志。",
    enabled: true,
  },
  activate(api) {
    api.register("commands", {
      id: "example.hello.show",
      name: "Hello: 显示工程名称",
      run() {
        api.host.log(api.project.get().project.name);
        api.events.emit("hello:shown");
      },
    });
  },
};
```

在 `src/plugins/builtin/index.tsx` 导入 `helloPlugin` 并加入 `builtinPlugins` 数组。启动后在 Plugins 中查看，在 `Ctrl+K` / `⌘K` 命令面板中执行。命令输出显示在 Console。插件停用后命令会被移除。贡献 ID 在同类能力内必须唯一。

## AI API 设置

在 Plugins 选择 **OpenAI Compatible API**，填写完整的 Chat Completions URL、模型名称和 API Key，然后在右侧面板发送问题。远程地址使用 HTTPS，开发时允许 localhost HTTP。

地址和模型自动保存，API Key 只保留在本次应用会话内。请求直接从浏览器/WebView 发出，服务需允许 CORS。发送时会把当前工程的代码和电路上下文传给所配置的服务。未配置、网络失败或 HTTP 错误会明确显示，不生成预设成功回复。

## 尚未实现

真实 MicroPython 执行器、编译器集成、物理电路仿真、串口/USB、真实烧录、网络协议、Agent 工具执行和自动改码、真实硬件测试、文件导入导出、云同步、账号和分享、语音及附件上传。

外部插件安装、市场、版本依赖解析、跨进程 RPC、沙箱与完整权限系统当前尚未提供。
