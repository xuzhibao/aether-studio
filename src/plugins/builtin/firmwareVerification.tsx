import { lazy, Suspense } from "react";
import type { StudioPlugin } from "../api";
// Store-backed UI loads on demand: the registry initializes before the stores.
const LazyPanel = lazy(() => import("./FirmwareVerificationPanel").then((module) => ({ default: module.FirmwareVerificationPanel })));
function FirmwareVerificationPanel() {
  return <Suspense fallback={<div className="p-4 text-xs">Loading firmware verification…</div>}><LazyPanel /></Suspense>;
}

// Product entry point for the beta.10 real-firmware verification flow. It does not replace the
// Demo Simulation plugin: this panel only drives a real QEMU process and a real ESP serial port.
export const firmwareVerificationPlugin: StudioPlugin = {
  manifest: {
    id: "aether.firmware.verification",
    name: "Firmware Verification（固件验证）",
    version: "0.1.0",
    type: "simulator",
    entry: "builtin/firmwareVerification.tsx",
    enabled: true,
    description: "真实 PlatformIO 构建、Espressif QEMU 启动与宿主随机挑战，随后只写活动 OTA 槽中的同一 app 镜像，并以新串口会话完成实机挑战。示例为 ESP32-C3（ESP-IDF 5.4.1）。",
    settings: [{
      key: "qemu.path",
      label: "Espressif QEMU（qemu-system-riscv32）",
      type: "tool-path",
      tool: "qemu-esp32c3",
      placeholder: "例如 C:/tools/qemu/qemu-system-riscv32.exe",
      help: "必须是 Espressif 官方构建（版本包含 esp/espressif）。留空时依次使用环境变量 AETHER_QEMU_RISCV32，最后查找 PATH 中的 qemu-system-riscv32。只支持 ESP32-C3 机器；上游 QEMU 没有 ESP32 机器。",
    }],
    settingsHelp: "本面板只验证一个真实可复验的 ESP32-C3 示例工程，不是通用板型兼容测试，也不模拟电路电气行为。QEMU 与本机实机串口互斥，写入前仍需既有预检和用户确认。",
  },
  activate(api) {
    api.register("panels", { id: "firmware.verification", name: "Firmware Verification", render: FirmwareVerificationPanel });
    api.register("commands", {
      id: "firmware.verification.open",
      name: "Firmware Verification: 打开固件验证面板",
      run: async () => { const { useStudio } = await import("../../store/studio"); useStudio.getState().setTab("panel:firmware.verification"); },
    });
  },
};
