import type { StudioPlugin } from "../api";
import { registerFirmwareDevTools, runFirmwareDevAgent } from "./firmwareDevTools";

// Product entry point for the explicit-start automatic firmware task.
//
// It contributes one agent and registers its typed tools from `firmwareDevTools.ts`; the slim
// start/stop block is embedded in the existing Agent panel. It does not duplicate the Firmware
// Verification panel, keeps no background worker and exposes no developer-facing console.
export const firmwareDevPlugin: StudioPlugin = {
  manifest: {
    id: "aether.firmware.dev", name: "自动固件任务（ESP32-C3 验证工程）", version: "0.1.0", type: "agent",
    entry: "builtin/firmwareDev.tsx", enabled: true,
    dependencies: ["aether.ai.openai", "aether.firmware.verification"],
    description: "显式开始的受控开发任务：真实构建、QEMU 两次启动、只读核对、app-only 写入与新会话 COUNT 观察，全部由内置 Agent 按序调用已授权动作。",
    settingsHelp: "只作用于当前打开的 ESP32-C3 验证工程与已授权的专用测试板。开始前需确认环境、端口与本次 app-only 写入授权；停止会直接中断真实进程与租约，不会自动回滚已开始的写入。",
  },
  activate(api) {
    registerFirmwareDevTools(api);
    api.register("agents", {
      id: "firmware-dev", name: "自动固件任务",
      run: (project, messages, signal, onTool) => runFirmwareDevAgent(api, project, messages, { signal, onTool }),
    });
  },
};
