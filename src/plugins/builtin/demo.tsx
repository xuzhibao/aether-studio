import { useEffect, useState } from "react";
import type { StudioPlugin } from "../api";
function DemoPanel() {
  return <div className="p-5 text-[12px] leading-6 text-[#59616A]"><h2 className="text-[16px] font-semibold">Demo Simulation</h2><p>数据由插件生成，不执行 Python，不验证接线，也不连接真实硬件。</p><p>添加 BME280 和 OLED 后点击 Run。输出显示在底部 Serial / Console 面板。</p></div>;
}
export const demoPlugin: StudioPlugin = {
  manifest: { id: "aether.demo", name: "Demo Simulation", version: "0.1.0", type: "simulator", entry: "builtin/demo.tsx", dependencies: ["aether.esp32-s3", "aether.components", "aether.micropython"], enabled: true, description: "生成环境读数和 OLED 演示帧；不执行固件、不模拟电路物理行为。" },
  activate(api) {
    function SamplePanel() {
      const [lastSample, setLastSample] = useState<unknown>(null);
      useEffect(() => api.events.on("demo:sample", setLastSample), []);
      return <div><DemoPanel /><pre className="px-5 text-[11px]">{lastSample ? JSON.stringify(lastSample, null, 2) : "尚无样本；请先运行 Demo Simulation。"}</pre></div>;
    }
    api.register("overlays", { id: "demo.readings", render: ({ readings, running }) => <div className="hud-card pointer-events-none absolute bottom-[18px] right-4 w-[243px] p-3 text-[10px] text-[#727A83]"><div className="font-semibold text-[#2B2F35]">Demo Simulation · {running ? "Running" : "Idle"}</div><div className="mt-2">{readings.temperature} °C · {readings.humidity}% · {readings.pressure} hPa</div><div className="mt-2 border-t border-[#EEF0F3] pt-2">生成数据 · 不执行固件 · 无真实设备</div></div> });
    api.register("simulators", {
      id: "demo", name: "Demo Simulation",
      start: ({ components }) => {
        for (const kind of ["board", "bme280", "oled"]) if (!components.some((c) => c.kind === kind)) throw new Error(`Demo Simulation 缺少元器件：${kind}`);
        return ["Demo Simulation started · generated data only", "不执行 main.py，不验证接线，无真实硬件连接。"];
      },
      tick: (_project, elapsed) => {
        const readings = { temperature: +(24.6 + Math.sin(elapsed / 5) * 0.6).toFixed(1), humidity: +(48.2 + Math.cos(elapsed / 7)).toFixed(1), pressure: +(1013.2 + Math.sin(elapsed / 9)).toFixed(1) };
        api.events.emit("demo:sample", readings);
        return { readings, lines: [`[Demo Simulation] T=${readings.temperature} °C RH=${readings.humidity}% P=${readings.pressure} hPa · OLED demo frame ${elapsed}`] };
      },
    });
    api.register("commands", { id: "demo.run", name: "Demo Simulation: 运行", run: () => api.host.runSimulation() });
    api.register("panels", { id: "demo.about", name: "Demo Simulation 说明", render: SamplePanel });
    api.register("menus", { id: "demo.menu", name: "运行 Demo Simulation", command: "demo.run" });
  },
};
