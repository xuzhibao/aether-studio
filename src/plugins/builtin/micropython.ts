import { createElement, lazy, Suspense } from "react";
import type { StudioPlugin } from "../api";
// Store-backed UI loads on demand: the plugin registry initializes before the stores.
const LazyRunPanel = lazy(() => import("./MicropythonRunPanel").then((module) => ({ default: module.MicropythonRunPanel })));
const LazyFilesPanel = lazy(() => import("./MicropythonFilesPanel").then((module) => ({ default: module.MicropythonFilesPanel })));
const MicropythonRunPanel = () => createElement(Suspense, { fallback: createElement("div", { className: "p-4 text-xs" }, "Loading MicroPython panel…") }, createElement(LazyRunPanel));
const MicropythonFilesPanel = () => createElement(Suspense, { fallback: createElement("div", { className: "p-4 text-xs" }, "Loading MicroPython panel…") }, createElement(LazyFilesPanel));

export const micropythonPlugin: StudioPlugin = {
  manifest: {
    id: "aether.micropython", name: "MicroPython", version: "0.3.0", type: "toolchain", entry: "builtin/micropython.ts", enabled: true,
    description: "提供示例代码和工程文件检查，并通过官方 mpremote 在已安装 MicroPython 的设备上运行当前工程中已保存的 .py 文件、只读浏览板载文件并下载单个文件；不安装固件，不提供板上文件上传、删除或重命名。",
    settings: [{ key: "mpremote.cli", label: "mpremote 可执行文件", type: "tool-path", tool: "mpremote", placeholder: "例如 C:/Users/you/AppData/Local/Programs/Python/Python313/Scripts/mpremote.exe", help: "留空时使用环境变量 AETHER_MPREMOTE，其次在 PATH 中查找 mpremote。也可以填写 mpremote.py，此时会通过 Python 解释器运行（可用 AETHER_MPREMOTE_PYTHON 指定解释器）。" }],
    settingsHelp: "运行任务使用固定 argv：connect port:<明确端口> run <本地文件>；板载文件面板使用 connect port:<明确端口> resume fs ls|cp。都不经过 shell，也不接受 auto/list。",
  },
  activate(api) {
    api.register("toolchains", {
      id: "micropython", name: "MicroPython (示例工具链)",
      files: () => ({
        "main.py": '# ESP32-S3 · BME280 + OLED 示例\n# Demo Simulation 不执行此 Python 文件，只产生演示数据。\n# 真机运行需自行安装 BME280 / SSD1306 驱动。\nfrom machine import Pin, I2C\nfrom bme280 import BME280\nfrom ssd1306 import SSD1306_I2C\nimport time\n\ni2c = I2C(0, sda=Pin(8), scl=Pin(9), freq=100_000)\nsensor = BME280(i2c=i2c)\ndisplay = SSD1306_I2C(128, 64, i2c)\n\nwhile True:\n    temperature, pressure, humidity = sensor.values\n    display.fill(0)\n    display.text(str(temperature), 0, 0)\n    display.text(str(humidity), 0, 20)\n    display.show()\n    print(temperature, humidity, pressure)\n    time.sleep(2)\n',
        "config.json": JSON.stringify({ runtime: "micropython", demo: true, sda: 8, scl: 9 }, null, 2),
        "README.md": "# ESP32-S3 示例\n\n在元器件库添加 BME280 和 OLED，编辑 main.py，然后运行 Demo Simulation。\n\n仿真使用生成数据，不解释 Python、不验证接线、不执行真实硬件。真实驱动、编译和烧录尚未接入。\n",
      }),
      check: ({ files }) => {
        if (!files["main.py"]?.trim()) throw new Error("main.py 不能为空");
        JSON.parse(files["config.json"]);
        return ["工程文件检查通过：main.py 非空，config.json 可解析。未执行 Python 语法检查或真实编译。"];
      },
    });
    api.register("commands", { id: "micropython.info", name: "MicroPython: 显示工具链信息", run: () => api.host.log("MicroPython 插件：提供工程文件检查；可通过 mpremote 在设备上运行已保存的 .py。不安装固件，不提供板上持久文件上传。") });
    api.register("panels", { id: "micropython.run", name: "在设备运行 Python", render: MicropythonRunPanel });
    api.register("panels", { id: "micropython.files", name: "板载文件（只读）", render: MicropythonFilesPanel });
    api.register("commands", { id: "micropython.run.open", name: "MicroPython: 在设备运行已保存的 Python 文件", run: async () => { const { useStudio } = await import("../../store/studio"); useStudio.getState().setTab("panel:micropython.run"); } });
    api.register("commands", { id: "micropython.files.open", name: "MicroPython: 浏览板载文件", run: async () => { const { useStudio } = await import("../../store/studio"); useStudio.getState().setTab("panel:micropython.files"); } });
  },
};
