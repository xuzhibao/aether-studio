import type { StudioPlugin } from "../api";
import { board } from "./hardware";
import { lazy, Suspense } from "react";
const LazyPanel = lazy(() => import("./BuildPanel"));
function BuildPanel() { return <Suspense fallback={<div>Loading tasks…</div>}><LazyPanel /></Suspense>; }
const ini = '[env:esp32-s3]\nplatform = espressif32@6.12.0\nboard = esp32-s3-devkitc-1\nframework = arduino\nmonitor_speed = 115200\n';
const source = '#include <Arduino.h>\n\nvoid setup() {\n    Serial.begin(115200);\n}\n\nvoid loop() {\n    Serial.println("Aether ESP32-S3 firmware");\n    delay(1000);\n}\n';
export const platformioPlugin: StudioPlugin = {
  manifest: { id: "aether.toolchain.platformio", name: "PlatformIO", version: "0.1.0", type: "toolchain", entry: "builtin/platformio.tsx", enabled: true, dependencies: ["aether.esp32-s3", "aether.editor.monaco"], description: "调用本机 PlatformIO Core 构建实际磁盘工程，记录日志、退出码、输入指纹、所选环境和产物校验和。提供 ESP32-S3 C++ 模板和任务面板。",
    settings: [{ key: "platformio.cli", label: "PlatformIO CLI 可执行文件", type: "tool-path", tool: "platformio", placeholder: "例如 C:/Users/you/.platformio/penv/Scripts/platformio.exe" }],
    settingsHelp: "构建、上传和生成编译数据库都使用这里保存的单个可执行文件路径和任务面板中选定的 platformio.ini 环境；已经运行的任务不会中途切换工具。留空时使用环境变量 AETHER_PLATFORMIO_CLI，其次查找 PATH 中的 platformio。该值始终作为一个参数传给进程（不经过 shell），路径中的空格、中文、分号或 && 都按字面处理；不支持 .bat、.cmd 或 .ps1。" },
  activate(api) {
    api.register("toolchains", { id: "platformio", name: "PlatformIO", files: () => ({ "platformio.ini": ini, "src/main.cpp": source }), check: ({ files }) => { if (!files["platformio.ini"]?.trim()) throw new Error("缺少 platformio.ini"); return ["已找到 PlatformIO 工程配置；尚未构建。"]; }, build: async () => { const { useDisk } = await import("../../store/disk"); await useDisk.getState().build("platformio.build"); } });
    api.register("deployments", {
      id: "platformio.upload", name: "PlatformIO Upload", toolchain: "platformio", endpointLabel: "Upload port",
      // Port enumeration stays a transport concern: the deployment plugin forwards to the active native serial plugin.
      ports: {
        list: async () => {
          const transport = api.capabilities.all("transports").find((item) => item.id === "native-serial");
          if (!transport) throw new Error("未启用桌面串口插件；请手动输入端口路径");
          if (transport.unavailable) throw new Error(transport.unavailable);
          if (!transport.list) throw new Error("当前串口插件不提供端口枚举；请手动输入端口路径");
          return transport.list();
        },
      },
      monitor: {
        label: "串口监视器", transportId: "native-serial", defaultBaudRate: "115200",
        connect: async (address, baudRate) => {
          const rate = Number(baudRate);
          if (!Number.isInteger(rate) || rate <= 0) throw new Error("请输入有效的监视波特率");
          const { useTransport } = await import("../../store/transport");
          await useTransport.getState().connectSerial(address, rate);
          const state = useTransport.getState();
          if (state.status !== "connected") throw new Error(state.error || "串口连接未建立");
        },
      },
      deploy: async (_project, port) => { const { useDisk } = await import("../../store/disk"); const task = await useDisk.getState().build("platformio.upload", { port }); return { taskId: task.id }; },
    });
    api.register("templates", { id: "ESP32-S3 C++", name: "ESP32-S3 C++", description: "PlatformIO · Arduino · 实际构建", board: "esp32-s3", create: () => ({ components: [structuredClone(board)], wires: [], files: { "platformio.ini": ini, "src/main.cpp": source }, capabilities: { board: "esp32-s3", toolchain: "platformio", simulator: "", editor: "monaco" } }) });
    api.register("panels", { id: "build.tasks", name: "Build Tasks", render: BuildPanel });
    api.register("commands", { id: "compiledb.platformio", name: "Generate compilation database (PlatformIO)", run: async () => { const { useDisk } = await import("../../store/disk"); const { useStudio } = await import("../../store/studio"); useStudio.getState().openFile("panel:build.tasks"); await useDisk.getState().build("platformio.compiledb"); } });
    api.register("commands", { id: "build.platformio", name: "Build project (PlatformIO)", run: () => api.host.buildProject() });
  },
  deactivate() { void import("../../store/disk").then(({ useDisk }) => { for (const task of useDisk.getState().tasks.filter((task) => task.status === "running" && task.provider.startsWith("platformio."))) void useDisk.getState().cancel(task.id).catch((error) => useDisk.setState({ error: String(error) })); }); },
};
