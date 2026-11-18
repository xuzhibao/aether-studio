# Aether Studio

Aether Studio 是一个开源硬件开发工作区，使用 Electron、React、TypeScript 和 Monaco。它提供电路画布、文本编辑器、磁盘工程、构建任务、串口和 WebSocket 监视器，以及可配置的 AI 工程助手。

**万物皆插件**：宿主提供窗口、文件访问、任务与资源管理、事件和 UI 扩展入口；开发板、元器件、编辑器、语言服务、终端、工具链、部署、仿真和 AI 通过插件注册。官方功能也使用同一注册表。

## 当前功能

- 保留 macOS 风格布局、电路画布、Monaco、命令面板和 Agent 面板。
- 插件启停、依赖检查、事件、设置，以及命令、菜单和面板贡献。
- 打开真实工程目录，编辑 UTF-8 文本、新建文件、保存、检测外部变更和重启后重开。
- 异常退出恢复：未保存的文本缓冲区、电路和工程上下文按工程写入用户数据目录的恢复草稿；重启后可预览、恢复、丢弃或稍后处理。
- C/C++ 语言插件：调用本机 clangd，提供已打开文件的诊断、补全、悬停和工程内定义跳转。
- PlatformIO C++ 工程构建：实际进程、实时日志、退出码、取消任务和子进程清理。
- 构建成功后记录已加载工程文本快照 SHA-256、PlatformIO 版本、产物路径、大小和校验和。
- PlatformIO 部署插件：明确填写端口后，运行实际构建及上传命令。不会因为打开串口而显示烧录成功。
- ESP32-S3 C++ 模板，以及 MicroPython 电路演示模板。
- 交互式 PTY 终端：在磁盘工程目录启动本机 shell，支持输入、中断、尺寸调整和会话清理。
- 原生串口与 WebSocket 字节通信；设备输出与 Demo Simulation 分开显示。
- `.aether` 工程导入导出、面板布局和编辑设置保存。
- 可配置的 Chat Completions API、工程读取工具、文件修改建议预览、应用、拒绝和请求取消。

**Demo Simulation 只生成演示数据，不执行 Python、不验证电气接线、不连接真实硬件。** C++ 模板不绑定演示仿真器。构建成功不代表已烧录，上传成功应以实际任务结果为准。

## 下载桌面包

[GitHub Releases](https://github.com/xuzhibao/aether-studio/releases) 提供预发行测试包：

| 系统 | 架构 | 文件 |
| --- | --- | --- |
| Windows | x64 | `.exe` 安装包，或 `.zip` 解压后运行 `AetherStudio.exe` |
| macOS | Apple Silicon / arm64 | 对应 `arm64` 的 `.dmg` 或 `.zip` |
| macOS | Intel / x64 | 对应 `x64` 的 `.dmg` 或 `.zip` |
| Linux | x64 | `.AppImage` 或 `.tar.gz` |

macOS 将 Aether Studio.app 放入应用程序目录。Linux AppImage 需添加执行权限；无 FUSE 时可添加 `--appimage-extract-and-run` 参数，或使用 tar.gz 解压目录中的 `aether-studio`。

macOS 包使用 ad-hoc 临时签名，未经 Apple 公证；Windows 包未做发布者签名。系统可能要求手动允许运行。`SHA256SUMS` 提供所有下载文件的 SHA-256。

下载包不捆绑 PlatformIO、clangd、芯片 SDK 或 AI 服务。可以先体验工程编辑、Demo Simulation 和交互终端，再按需安装开发工具。

## 安装与启动

需要 Node.js 22.12.0 或更新版本：

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

首次启动或打包会下载 Electron 运行时。输出位于 `release/`。打包命令包含前端、主进程、第三方许可收集及 Electron 打包。此命令只生成应用目录；发布包使用下面的发行构建命令。尚未提供自动更新。

发行构建需要在对应操作系统及架构上执行：

```bash
npm run desktop:release
```

Windows 输出安装包和 ZIP，macOS 输出 DMG 和 ZIP，Linux 输出 AppImage 和 tar.gz。GitHub 的 **Desktop release** 工作流会构建并启动检查四种目标；主分支通过完整冒烟和全部目标检查后才创建 Release，并在全部文件上传后公开。已发布版本不会被自动覆盖，下一次发布需更新版本号。

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

安装版也可以在应用内配置，不必为每次启动设置环境变量：

1. 打开 **Plugins** → **PlatformIO** → **插件设置**。
2. 在 **PlatformIO CLI 可执行文件** 中填写完整路径，或点 **浏览…** 选择文件；点 **检测** 会实际运行 `--version`，显示版本或具体错误。
3. 路径保存在应用用户数据目录（`AETHER_USER_DATA_DIR` 下的 `tools.json`），重启应用后自动恢复。

查找顺序为：应用内保存的路径 → 环境变量 `AETHER_PLATFORMIO_CLI` → `PATH` 中的 `platformio`。只保存单个可执行文件路径，不会拼接成 shell 命令；含空格、中文、分号或 `&&` 的路径按原样作为单个参数传给进程，不经过 shell 解析。Windows 请选择 `.exe`，`.bat`、`.cmd` 和 `.ps1` 不在支持范围。构建、上传和生成编译数据库在任务启动时固定使用当时的可执行文件；运行中的任务不会因为保存新路径而中途换工具。

## 磁盘工程

工程菜单或命令面板提供：

- **Open project folder**：打开已有目录，快捷键 `Ctrl+Alt+O` / `⌘⌥O`。
- **Save project to folder**：将当前工作区写入空目录，不覆盖已有目录内容。
- **Reload folder (discard unsaved edits)**：重新读取磁盘，放弃当前未保存缓冲区。

打开普通 PlatformIO 目录时不执行工程脚本；点击构建或上传才执行工具及工程配置中的构建脚本。请只构建可信工程。

目录中的普通源文件保持原有路径。Aether 元数据保存在 `aether.project.json`，电路定义保存在 `hardware/circuit.json`。界面的 `circuit.json` 是电路的只读视图，不能作为独立源文件创建；打开目录时若根目录已有同名文件，需要先重命名。

保存使用外部变更检查和逐文件临时写入。文件被外部修改后，Aether 拒绝覆盖；可重新读取目录，或将当前缓冲区另存到空目录。保存不是整个工程的文件系统事务，异常中断后不要直接删除 `.aether-saving` 文件，应先检查其中内容。

当前加载不超过 1 MiB 的 UTF-8 文本文件，跳过链接、二进制和工具缓存目录，包括 `.git`、`.pio`、`.aether`、`.cache`、`node_modules`、`build`、`dist`、`target`、`release`。未加载的文件不会被保存操作删除或改写。尚未提供外部编辑自动合并或多根工作区。

在 **Project files** 文件树中可以新建文件或目录、重命名、移动到系统回收站。操作只接受当前工程的相对路径，不能修改 `aether.project.json`、`hardware/circuit.json`、电路视图 `circuit.json`、工程根目录、工具缓存目录或工程内的符号链接。删除调用系统回收站而不是永久删除；目录重命名会同时移动其中的文件。重命名或删除有未保存修改的文件时，会先要求选择保存、取消或放弃。

外部修改、删除或新增会按文件列出。打开 **Review disk changes…**（或顶部“按文件处理…”）可以比较磁盘版本与本地缓冲区，并选择使用磁盘版本、保留本地并覆盖该文件、从本地内容重建被删除的文件，或载入磁盘新增文件。处理一个文件不会丢弃其他文件的未保存修改；未处理的冲突仍会阻止整工程保存。

磁盘工程源码以文件系统为准；`localStorage` 用于浏览器工作区和界面偏好。桌面最近打开目录记录在应用用户数据目录，重启时重新读取文件。可通过 `AETHER_USER_DATA_DIR` 指定用户数据位置。

### 崩溃恢复草稿

桌面端在工程有未保存修改时，会把文本缓冲区、电路元件与连线、工程信息、已打开标签页写入应用用户数据目录下的 `recovery/`。每个工程根路径有独立目录，草稿写入前先写临时文件再原子重命名，编辑停止约 0.7 秒后更新。恢复草稿与正常工程保存完全分开：它不会写入工程目录，也不会自动覆盖磁盘文件。浏览器工作区不使用恢复草稿。

应用被强制结束或崩溃后再次启动，会自动打开 **恢复未保存内容** 窗口，列出草稿的工程路径、时间、文件数和预览内容：

- **恢复此草稿**：内容进入编辑缓冲区并标记为未保存，磁盘文件保持不变。保存时仍会执行现有的外部修改检查；若文件在恢复后又被外部修改，保存会被拒绝。
- **丢弃此草稿**：只删除该工程的恢复草稿，不修改工程目录。
- **稍后处理**：保留草稿并关闭窗口，可通过文件树中的“恢复草稿”入口或命令面板 **Open recovery drafts** 再次打开。

正常保存成功后，只清除本次保存实际处理的那个草稿版本；如果保存过程中又产生了新编辑，更新的草稿会保留。重新读取目录（放弃未保存修改）或显式丢弃草稿会清除对应草稿；在打开其他目录或退出应用时确认“放弃修改”，同样会清除该工程的草稿，不会在下次启动时复活。工程目录在应用退出期间被外部删除时，草稿仍可预览；恢复后继续编辑仍会更新草稿，保存只能使用 **Save project to folder** 保存到新目录。草稿文件损坏时，窗口显示可理解的错误并保留草稿文件供检查，不会读取或修改工程源码，也不会静默删除；在显式丢弃前，新的自动保存不会覆盖已损坏的草稿内容。

崩溃期间磁盘上的变化不会被静默覆盖：普通文件（包括草稿中有、但写草稿时磁盘上尚无的同名文件）会按文件显示为冲突；宿主管理的 `hardware/circuit.json` 和 `aether.project.json` 若在停机期间变化，恢复窗口会明确提示，整工程保存会被阻止，需要另存到新目录或重新读取磁盘版本。Save-to-folder 期间产生的新编辑会保留在缓冲区并继续标记为未保存，只清除实际写入新目录的那个草稿版本。

草稿超过 16 MB 时不会写入，应用会提示先保存工程。恢复草稿只保存已加载的文本文件（与工程加载规则一致，单个文件上限 1 MiB）；二进制、链接和工具缓存目录不会进入草稿。

## 构建与上传

在 **Plugins** 启用 PlatformIO，然后创建 **ESP32-S3 C++** 模板，或打开现有 `platformio.ini` 工程。新建模板需先 **Save project to folder**。

点击 **Build**，或在左侧 **Build Tasks** 中选择 **Build with PlatformIO**。任务运行前保存工程文件，并断开设备通信。运行期间可以编辑缓冲区，但需等待或取消任务后再保存；下次构建才会使用这些编辑。

**Build Tasks** 顶部显示由 `platformio.ini` 解析出的环境。环境列表来自 `platformio project config --json-output`；声明了 `default_envs` 时标记默认环境，否则默认选第一个。构建、上传和生成编译数据库都会显式传入 `-e 环境名`，任务启动时固定该环境，运行期间不能切换。产物只按该环境的 `.pio/build/环境名` 目录登记，不会把其他环境的旧产物记为成功。

最近成功任务保存在 `.aether/build.json`，包含已加载文本与元数据的快照指纹、工具版本、所选环境、日志和产物校验和。构建前后若已加载的磁盘输入发生变化，不登记产物。此前成功任务的记录不代表当前未保存缓冲区已经构建。

上传时点击 **Deploy to Device**，选择 **PlatformIO Upload**。对话框列出操作系统报告的串口路径、厂商和 VID/PID，点击一项填入，也可以手动输入未枚举到的路径；留空不会开始上传。这个列表不能判断开发板型号或固件，应用不会自动识别型号，也不会自动刷写未知设备。如果枚举与实际不符，拔插一次 USB 后点 **刷新端口**。

上传前应用先断开当前串口监视器，并确认端口已释放；若关闭失败会取消任务并显示错误，而不是继续上传。插件执行 `platformio run -e ENV --target upload --upload-port PORT`，由 `platformio.ini` 决定芯片、构建和烧录方式。对话框显示真实任务状态、退出码和 PlatformIO 日志，区分运行中、成功、失败和已取消；成功仅表示命令退出码为 0，不代表固件已启动、设备已识别或启动日志正常。

任务结束后，可以直接在任务卡片点击 **连接串口监视器** 打开同一端口，连接波特率取 `platformio.ini` 的 `monitor_speed`（未声明时 115200）；也可以打开 **Devices**（会预填最近使用的串口）。端口被其他程序占用、上传中拔线或命令失败时，日志和退出码保留；修正后点 **重试上传** 会启动新任务，不复用已结束的任务或旧串口句柄。上传会修改设备固件，并可能使开发板复位。MicroPython 文件部署尚未接入。

ESP32-S3 实机检查步骤见 [docs/esp32-s3-upload-acceptance.md](docs/esp32-s3-upload-acceptance.md)。

不连接硬件也可打开 `examples/platformio-native`，使用本机 GCC 构建一个真实 C++ 可执行文件。`examples/platformio-esp32s3` 提供固定平台版本的 ESP32-S3 Arduino 示例。

## C/C++ 编辑

安装本机 clangd，并确保它在应用进程的 PATH 中，或通过 `AETHER_CLANGD_CLI` 指定完整可执行文件路径。Ubuntu / Debian：

ESP32-S3 的 Xtensa 目标需要 clangd 20+（LLVM 20 起包含 Xtensa 支持）；Ubuntu 24.04 自带的 clangd 18 不够。Ubuntu 24.04 需要先加入 LLVM 官方源：

```bash
sudo apt-get update
sudo apt-get install -y lsb-release wget software-properties-common gnupg
wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key | sudo tee /etc/apt/trusted.gpg.d/llvm-snapshot.asc > /dev/null
sudo add-apt-repository -y "deb http://apt.llvm.org/noble/ llvm-toolchain-noble-20 main"
sudo apt-get update
sudo apt-get install -y clangd-20
# 然后在插件设置中把 clangd 可执行文件设为 /usr/bin/clangd-20，或设置 AETHER_CLANGD_CLI=/usr/bin/clangd-20。
```

也可以用 [clangd 官方独立包](https://github.com/clangd/clangd/releases)（比完整 LLVM 小），解压后在插件设置中填写 `clangd` 可执行文件的完整路径。原生 C/C++ 工程可用较旧版本，但 ESP32 交叉目标会在分析时报告不支持的目标架构。clangd 采用 Apache-2.0 WITH LLVM-exception；Aether 不捆绑该程序。

安装版可在 **Plugins** → **C/C++ · clangd** → **插件设置** 中保存 clangd 可执行文件路径，查找顺序同样为：应用内保存的路径 → `AETHER_CLANGD_CLI` → `PATH`。保存新路径后，正在运行的 clangd 会重启并重新载入已打开的 C/C++ 文档；启动失败时在 **C/C++ Language** 面板显示实际错误和当前使用的可执行文件。

打开磁盘 C/C++ 工程并启用 **C/C++ · clangd** 插件。编辑 `.c`、`.cpp`、`.cc`、`.cxx` 或头文件时启动语言服务。它分析未保存缓冲区，使用 UTF-16 位置同步；不会为诊断而自动保存源码。

- `Ctrl+Space` / `⌃Space`：补全。
- 悬停符号：查看类型和说明。
- `F12`：跳转已加载工程文件内的定义；系统头文件和工程外跳转尚未接入。
- 左侧 **C/C++ Language**：查看状态、日志和已打开文件的诊断，点击诊断定位代码，或停止、重启服务。

先在 **Build Tasks** 点击 **Generate compilation database**，或运行命令面板的 **Generate compilation database (PlatformIO)**。该任务实际执行 `platformio run -e ENV --target compiledb`，按工程配置运行构建脚本，并生成根目录 `compile_commands.json`；任务记录位于 `.aether/compiledb.json`，其中记录本次环境与文件校验和。它不等于固件编译或上传。

语言服务使用**当前选定环境**的数据库。生成成功后，正在运行的 clangd 会自动重启并重新载入已打开的缓冲区（包括未保存内容），不需要重开目录或重新打开文件。面板会区分三种状态：

- **未生成**：没有任务记录也没有数据库，clangd 使用默认参数。
- **无记录但可用**：工程根目录有 `compile_commands.json`（例如 CMake 或其他工具生成），但没有 PlatformIO 任务记录，且当前未选择 PlatformIO 环境时，直接使用该数据库并提示无法确认所属环境；一旦选择了环境，则视为需要重新生成。
- **已就绪**：任务记录的环境与当前选择一致，且 `compile_commands.json` 的 SHA-256 与记录一致。
- **已过期**：记录属于其他环境、数据库被改动或记录无法解析。此时 clangd 只读取一个空数据库，不会回退到根目录或上级目录的旧参数；请为当前环境重新生成。

PlatformIO 默认不把工具链 include 路径写入数据库（`COMPILATIONDB_INCLUDE_TOOLCHAIN` 默认为 false），但会写入框架依赖路径。需要在 **C/C++ Language** 面板显式勾选 **允许 clangd 运行当前环境解析出的编译器（--query-driver）**，clangd 才会运行所选环境的编译器来获取系统头文件路径。

允许列表在用户显式点击 **Generate compilation database** 时解析：该任务成功后执行 `platformio project metadata --json-output -e ENV`，把该环境的 `cc_path`/`cxx_path` 连同环境和时间写入 `.aether/compiledb.json` 的 `metadata`。启动或重启语言服务只读取这份缓存，不会运行 PlatformIO，也不会执行工程脚本；只有生成编译数据库这一显式任务会重跑 PlatformIO 的 integration（`extra_scripts`）。

缓存中的编译器还必须同时满足：路径是字面绝对路径（不含 `*`、`?`、`[]`、`,` 等会扩大或拆分匹配的字符，symlink 解析后的真实路径也需满足）、真实路径位于 PlatformIO 核心的 `packages` 目录（`PLATFORMIO_CORE_DIR`、默认 `~/.platformio`，或配置的 pio 可执行文件所属 `<core>/penv`）、并且正是当前编译数据库调用的编译器。否则不启用 query-driver。启用时只在该 clangd 子进程的 PATH 前加入这些已授权编译器所在目录，使数据库中的裸编译器名可以被解析；不会修改用户全局 PATH。勾选后带有未保存缓冲区的运行中会话会自动重启。

ESP32-S3 工程请使用 clangd 20+。数据库中的命令使用 `xtensa-esp32s3-elf-g++` 与 `-mlongcalls` 等真实交叉编译参数，不替换为宿主编译器，也不为迎合 clangd 修改构建参数。已知限制：上游 clang 不认识或改名的 GCC 驱动选项（`-mlongcalls`、`-fstrict-volatile-bitfields`、`-fno-tree-switch-conversion`）会被 clangd 报告为 Unknown argument。启用 query-driver 后，Arduino/框架头文件和工具链头文件解析、补全、悬停与工程内定义跳转均可正常工作；这几条驱动选项诊断不影响这些结果，实际构建结果仍以 PlatformIO 为准。

当前语言插件不启用 clangd 用户配置或后台全工程索引。只同步已打开的文件，保留打开标签页的缓冲区；关闭文件、停用插件、切换目录和退出应用会清理对应资源。尚未提供重命名、格式化、代码修复或全工程问题扫描。

## 终端

在左侧 **Terminal** 或命令面板的 **Open project terminal** 打开终端面板，然后点击 **Start terminal**。必须先打开或保存到磁盘工程目录；打开面板本身不启动 shell。

终端使用 node-pty 和 xterm.js，在当前工程目录启动真实 shell。Linux / macOS 使用 `SHELL`，未设置时使用 `/bin/bash`；Windows 使用 `ComSpec`，未设置时使用 `cmd.exe`。可通过 `AETHER_SHELL` 指定 shell 的完整可执行文件路径，不接受拼接的命令串。POSIX shell 使用 `-i` 启动，可能读取自己的交互配置。

- 聚焦终端后，键盘输入直接发送到 shell，`Ctrl+C` 中断前台命令；工作区不会拦截终端的 `Ctrl+R`、`Ctrl+K` 等快捷键。
- 面板尺寸改变会调整实际 PTY 的行列数。
- 切换工作区面板会保留会话和当前会话的显示历史。
- **Clear terminal** 只清理显示历史；**Stop terminal** 关闭会话。退出后的终端显示实际退出码，可再次启动。
- 停用终端插件、重新读取或切换工程，以及退出应用会关闭会话并清理会话内进程。主动脱离终端会话的守护进程不在此管理范围内。

终端拥有当前用户的文件与进程权限，命令可以修改工程及其他用户可访问的文件。它读取磁盘文件，不会自动保存编辑器缓冲区；终端造成的文件变更仍通过工作区的外部修改检查处理。面板标注的是启动目录，执行 `cd` 后以 shell 自己的当前目录为准。

目前一次只提供一个终端会话，显示历史最多 3000 行；窗口关闭后不恢复 shell 或终端历史。后台按 xterm 的消费进度读取 PTY 输出，并在输出积压时暂停生产者。Agent 尚不调用终端，也不会自动执行模型生成的命令。当前主要验证 Linux；macOS 和 Windows 需在对应系统验证。

首次安装原生依赖时，如果 node-pty 没有匹配的预构建文件，需要当前系统的 C/C++ 构建工具和 Python。桌面打包会为 Electron 重建原生模块。

## 设备通信

打开 **Devices**，选择通信插件及地址。原生串口支持端口枚举、点击选择、手动路径、波特率、8N1 和无流控。端口列表显示系统报告的路径、厂商和 VID/PID，这些信息不能识别开发板型号或固件；不会自动选择端口或自动刷写。窗口打开时会预填最近一次连接或上传使用的串口。

构建或上传任务运行时，应用会暂停原生串口连接，避免监视器重新占用上传端口。拔线或后端读取失败会显示连接中断；重新插好后需要重新选择或刷新端口再连接，不会复用已失效的句柄。WebSocket 支持 `ws://`、`wss://`，接收文本及二进制帧，发送携带 UTF-8 文本的二进制帧。

**Serial Monitor** 的 **Device transport** 显示实际接收数据，支持筛选、暂停显示、清空及换行选择。暂停显示不暂停接收。串口 TX 表示本地写入完成；WebSocket TX 表示进入发送队列，均不代表设备已执行命令。当前一次只连接一个设备或服务。

停用插件、切换工程或执行构建会断开通信。打开端口不识别开发板或固件；部分开发板可能因打开端口时控制线变化而复位。Linux 用户需要端口访问权限。

## AI

在 Plugins 配置 **OpenAI Compatible API** 的完整 Chat Completions URL、模型和 API Key。地址和模型保存到本地，Key 仅保留在当前会话。请求直接从渲染进程发出，服务需要允许对应来源的跨域访问；AI 服务不是 IDE 的必选依赖。

普通问答发送当前工程上下文；**Project Tools** 按模型请求读取文件或电路，并生成文件修改建议。修改须预览后应用，应用后仍需保存。文件改变后禁止用过期建议覆盖。Agent 不自动构建、上传或执行硬件操作。

## 插件开发

`src/plugins/api.ts` 定义 Manifest 和能力接口，`src/plugins/registry.ts` 管理注册、依赖、启停和清理。当前官方前端插件由 `src/plugins/builtin/index.tsx` 静态导入，运行在可信应用进程内。

插件通过 `api.register(kind, contribution)` 提供开发板、元器件、编辑器、语言服务、终端、工具链、部署、仿真器、通信、模型、Agent、工具、模板、命令、工程格式、菜单、面板和叠加视图。操作时使用 `api.project.get()` 读取当前工程；事件订阅在停用时移除。

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

桌面受限 API 定义在 `shared/desktop.ts`，preload 只暴露指定操作，不暴露 Node 或任意 IPC。后台构建任务只能调用已注册提供者；交互终端按用户输入执行 shell 命令，Agent 工具不连接终端。PlatformIO 的后台命令和产物发现位于 `desktop/plugins/platformio.ts`，串口适配位于 `desktop/plugins/serial.ts`。语言服务进程由 `desktop/language.ts` 管理，clangd 启动参数在 `desktop/plugins/clangd.ts`；`languages` 能力负责 Monaco 接入及诊断面板。`terminals` 能力提供交互终端操作和面板挂载，shell 提供者位于 `desktop/plugins/shell.ts`。插件 UI 可通过 `data-plugin-keyboard` 标注自己处理键盘事件的区域。

当前还没有本地插件包安装器、独立插件进程、完整沙箱和插件市场。前后端注册入口仍随应用构建，不宣称支持不可信外部插件。

## 检查

```bash
npm run typecheck
npm run smoke
npm run smoke:network
npm run smoke:terminal
npm run build
npm run build:desktop
npm run smoke:recovery
```

`npm run smoke` 还会用本地编译的临时 CLI 与 LSP fixture 检查工具路径的保存、恢复、优先级和进程接入；fixture 不是 PlatformIO 或 clangd 本身。`smoke:recovery` 直接检查恢复草稿的按工程隔离、原子写入、版本化清理、损坏草稿隔离和大小限制。`smoke:terminal` 在 POSIX 系统使用 bash、stty 和 Python 检查真实 PTY。真实文件、构建和语言检查需要 PlatformIO；语言检查还需要 clangd：

```bash
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" npm run smoke:host
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" npm run smoke:platformio
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" AETHER_CLANGD_CLI=/usr/bin/clangd-20 npm run smoke:language
AETHER_PLATFORMIO_CLI="$PWD/.venv/bin/platformio" AETHER_CLANGD_CLI=/usr/bin/clangd-20 npm run smoke:esp32
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

`smoke:crash` 会启动真实 Electron 应用，编辑缓冲区后强制结束进程，再启动新进程验证草稿预览、恢复、丢弃、稍后处理、外部修改保护、损坏草稿和工程目录被删除后的另存恢复：

```bash
npm run smoke:crash
```

Linux CI 使用 Xvfb 运行打包后的应用。测试仅替换系统文件选择器的选择结果；文件读写、任务、编译、系统虚拟串口和本地 WebSocket 收发实际执行。恢复草稿测试使用真实 SIGKILL 和真实用户数据目录，不使用伪造的保存成功提示。AI 使用明确标记的 HTTP 测试响应，没有在线模型或真实开发板验证。

## 许可与限制

Aether 原创代码采用 Apache-2.0，见 `LICENSE` 和 `NOTICE`。第三方组件保留原许可。`npm run licenses` 收集当前安装依赖及 Electron/Chromium 的许可，生成 `THIRD_PARTY_NOTICES.md` 和随桌面包分发的 `dist-licenses/`。该清单不等于对任意工程 SDK、模型权重和二进制附件的完整审计。

PlatformIO Core 使用 Apache-2.0；其下载的开发平台、编译器和 SDK 按各自许可提供。IDE 不要求商业模拟器、账号或付费模型。支持 ESP32 不代表其无线固件依赖全部提供源码。

当前尚未提供其他语言的 LSP、DAP 调试、Git 面板、真实固件仿真、MicroPython 设备文件管理、外部插件安装、签名安装器和自动更新。电路画布不提供电气正确性保证。真实设备上传及 macOS/Windows 的完整硬件工作流仍需在对应环境验证，发行检查仅覆盖打包启动和基础操作。
