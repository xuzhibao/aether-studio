import { lazy, Suspense } from "react";
import type { StudioPlugin } from "../api";
// Store-backed UI loads on demand: the plugin registry (and this module) initialize before the stores.
const LazyPanel = lazy(() => import("./EspDevicePanel").then((module) => ({ default: module.EspDevicePanel })));
function EspDevicePanel() { return <Suspense fallback={<div className="p-4 text-xs">Loading ESP device panel…</div>}><LazyPanel /></Suspense>; }

export const espDevicePlugin: StudioPlugin = {
  manifest: {
    id: "aether.esp.device", name: "ESP 设备检测", version: "0.4.0", type: "device", entry: "builtin/espDevice.tsx", enabled: true,
    description: "按端口显式触发只读的 esptool 检测：芯片、flash、板上分区表与安全状态；同时为部署前核对提供设备侧事实。使用 PlatformIO 自带的 tool-esptoolpy 或单独配置的 esptool。",
    settings: [{ key: "esptool.path", label: "esptool 路径（可选）", type: "tool-path", tool: "esptool", placeholder: "例如 C:/Users/you/.platformio/packages/tool-esptoolpy/esptool.py", help: "留空时依次使用环境变量 AETHER_ESPTOOL、PlatformIO 自带的 tool-esptoolpy（本机实测 4.9.0），最后查找 PATH 中的 esptool。指定 .py 时会用 PlatformIO 的 Python 解释器运行。" }],
    settingsHelp: "ESP 检测与部署前核对都只读。工具路径作为单个参数传给进程，不经过 shell；不支持 .bat、.cmd、.ps1。",
  },
  activate(api) {
    const desktop = () => {
      const esp = typeof window === "undefined" ? undefined : window.aether?.esp;
      if (!esp) throw new Error("ESP 检测需要 Electron 桌面端");
      return esp;
    };
    api.register("devices", {
      id: "esp32", name: "ESP32 / ESP32-C3 / ESP32-S3（esptool 只读）",
      inspect: (port) => desktop().inspect(port),
      // The UI preview; the authoritative checks run again inside esp.upload while the port is locked.
      preflight: (options) => desktop().preflight(options),
      uploadProvider: "esp.upload",
    });
    api.register("panels", { id: "esp.device", name: "ESP 设备", render: EspDevicePanel });
    api.register("commands", { id: "esp.openDevice", name: "ESP: 打开设备面板（只读检测）", run: async () => { const { useStudio } = await import("../../store/studio"); useStudio.getState().setTab("panel:esp.device"); } });
  },
};
