import type { StudioPlugin } from "../api";
export const micropythonPlugin: StudioPlugin = {
  manifest: { id: "aether.micropython", name: "MicroPython", version: "0.1.0", type: "toolchain", entry: "builtin/micropython.ts", enabled: true, description: "提供示例代码和工程文件检查；尚未接入真实编译器。" },
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
    api.register("commands", { id: "micropython.info", name: "MicroPython: 显示工具链信息", run: () => api.host.log("MicroPython 示例工具链：文件检查已实现，真实编译/烧录尚未实现。") });
  },
};
