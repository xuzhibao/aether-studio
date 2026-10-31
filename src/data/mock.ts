import type {
  AgentMessage,
  ConsoleLine,
  HwComponent,
  Pin,
  ProjectMeta,
  SerialLine,
  Wire,
} from "../types";

const pitch = 17.6;
const pinY = (i: number) => 52 + i * pitch;

const leftPins: Array<[string, string, Pin["signal"], string?]> = [
  ["3V3", "3V3", "power", "3.3 V rail · 600 mA"],
  ["GND", "GND", "gnd", "System ground"],
  ["EN", "EN", "gpio", "Reset / enable"],
  ["IO4", "GPIO 4", "gpio", "Digital I/O · ADC1"],
  ["IO5", "GPIO 5", "gpio", "Digital I/O · ADC1"],
  ["IO6", "GPIO 6", "gpio", "Digital I/O"],
  ["IO7", "GPIO 7", "gpio", "Digital I/O"],
  ["IO15", "GPIO 15", "gpio", "Digital I/O"],
  ["IO16", "GPIO 16", "gpio", "Digital I/O"],
  ["IO17", "GPIO 17", "gpio", "Digital I/O"],
  ["IO18", "GPIO 18", "gpio", "Digital I/O"],
  ["IO8", "GPIO 8", "i2c", "I²C SDA · default bus 0"],
  ["IO19", "GPIO 19", "gpio", "USB D−"],
  ["IO20", "GPIO 20", "gpio", "USB D+"],
  ["IO3", "GPIO 3", "gpio", "Strapping pin"],
  ["IO46", "GPIO 46", "gpio", "Strapping pin"],
  ["IO9", "GPIO 9", "i2c", "I²C SCL · default bus 0"],
  ["IO10", "GPIO 10", "gpio", "Digital I/O"],
];

const rightPins: Array<[string, string, Pin["signal"], string?]> = [
  ["GND", "GND", "gnd", "System ground"],
  ["GND", "GND", "gnd", "System ground"],
  ["5V", "5V", "power", "5 V input · USB VBUS"],
  ["IO43", "GPIO 43", "gpio", "UART0 TX"],
  ["IO44", "GPIO 44", "gpio", "UART0 RX"],
  ["IO1", "GPIO 1", "gpio", "ADC1 · digital I/O"],
  ["IO2", "GPIO 2", "gpio", "Status LED · digital out"],
  ["IO42", "GPIO 42", "gpio", "JTAG MTMS"],
  ["IO41", "GPIO 41", "gpio", "JTAG MTDI"],
  ["IO40", "GPIO 40", "gpio", "JTAG MTDO"],
  ["IO39", "GPIO 39", "gpio", "JTAG MTCK"],
  ["IO38", "GPIO 38", "gpio", "Digital I/O"],
  ["IO37", "GPIO 37", "gpio", "Digital I/O"],
  ["IO36", "GPIO 36", "gpio", "Digital I/O"],
  ["IO35", "GPIO 35", "gpio", "Digital I/O"],
  ["IO0", "GPIO 0", "gpio", "Boot strapping"],
  ["IO45", "GPIO 45", "gpio", "Strapping pin"],
  ["IO48", "GPIO 48", "gpio", "RGB LED"],
];

const boardPins: Pin[] = [
  ...leftPins.map(([id, label, signal, note], i) => ({
    id: "l" + i,
    label,
    signal,
    note,
    x: 2,
    y: pinY(i),
    dir: "left" as const,
  })),
  ...rightPins.map(([id, label, signal, note], i) => ({
    id: "r" + i,
    label,
    signal,
    note,
    x: 234,
    y: pinY(i),
    dir: "right" as const,
  })),
];

export const board: HwComponent = {
  id: "board-1",
  kind: "board",
  name: "ESP32-S3 DevKitC-1",
  reference: "U1",
  x: 466,
  y: 201,
  w: 236,
  h: 360,
  pins: boardPins,
  props: {
    MCU: "ESP32-S3-WROOM-1 (N8R2)",
    Cores: "Dual-core Xtensa LX7 · 240 MHz",
    Flash: "8 MB",
    PSRAM: "2 MB",
    "USB-C": "Native USB 1.1 · COM3",
    Power: "5 V via USB-C",
  },
};

export const bme280: HwComponent = {
  id: "sensor-bme280",
  kind: "bme280",
  name: "BME280 Sensor",
  reference: "U2",
  x: 172,
  y: 428,
  w: 170,
  h: 122,
  pins: [
    { id: "vin", label: "VIN", signal: "power", x: 178, y: 34, dir: "right", note: "3.3 V supply" },
    { id: "gnd", label: "GND", signal: "gnd", x: 178, y: 54, dir: "right", note: "Ground" },
    { id: "sda", label: "SDA", signal: "i2c", x: 178, y: 74, dir: "right", note: "I²C data · GPIO 8" },
    { id: "scl", label: "SCL", signal: "i2c", x: 178, y: 94, dir: "right", note: "I²C clock · GPIO 9" },
  ],
  props: {
    Interface: "I²C · 400 kHz",
    Address: "0x76",
    Range: "300–1100 hPa",
    Accuracy: "±0.12 hPa · ±0.5 °C",
  },
};

export const oled: HwComponent = {
  id: "display-oled",
  kind: "oled",
  name: "OLED 0.96″",
  reference: "DS1",
  x: 160,
  y: 160,
  w: 204,
  h: 136,
  pins: [
    { id: "gnd", label: "GND", signal: "gnd", x: 48, y: 144, dir: "down", note: "Ground" },
    { id: "vcc", label: "VCC", signal: "power", x: 88, y: 144, dir: "down", note: "3.3 V supply" },
    { id: "scl", label: "SCL", signal: "i2c", x: 128, y: 144, dir: "down", note: "I²C clock · GPIO 9" },
    { id: "sda", label: "SDA", signal: "i2c", x: 168, y: 144, dir: "down", note: "I²C data · GPIO 8" },
  ],
  props: {
    Controller: "SSD1306",
    Resolution: "128 × 64",
    Interface: "I²C · 0x3C",
    Refresh: "2 Hz · partial",
  },
};

export const resistor: HwComponent = {
  id: "resistor-1",
  kind: "resistor",
  name: "Resistor 220 Ω",
  reference: "R1",
  x: 748,
  y: 403,
  w: 78,
  h: 24,
  pins: [
    { id: "p1", label: "1", signal: "gpio", x: 0, y: 12, dir: "left", note: "From GPIO 2" },
    { id: "p2", label: "2", signal: "gpio", x: 78, y: 12, dir: "right", note: "To LED anode" },
  ],
  props: {
    Value: "220 Ω",
    Tolerance: "±1%",
    Power: "0.25 W",
    Package: "Axial · THT",
  },
};

export const led: HwComponent = {
  id: "led-1",
  kind: "led",
  name: "Status LED",
  reference: "D1",
  x: 850,
  y: 391,
  w: 44,
  h: 48,
  pins: [
    { id: "a", label: "A", signal: "gpio", x: 0, y: 24, dir: "left", note: "Anode" },
    { id: "k", label: "K", signal: "gnd", x: 44, y: 24, dir: "right", note: "Cathode" },
  ],
  props: {
    Color: "Red · 625 nm",
    Forward: "2.0 V @ 20 mA",
    Lens: "5 mm diffused",
    State: "PWM · 40%",
  },
};

export const initialComponents: HwComponent[] = [board, bme280, oled, resistor, led];

const p = (id: string, pin: string) => ({ comp: id, pin });

export const initialWires: Wire[] = [
  { id: "w1", from: p("board-1", "l0"), to: p("sensor-bme280", "vin"), signal: "power", color: "#E15B4F", lane: 0 },
  { id: "w2", from: p("board-1", "l1"), to: p("sensor-bme280", "gnd"), signal: "gnd", color: "#41464F", lane: 1 },
  { id: "w3", from: p("board-1", "l11"), to: p("sensor-bme280", "sda"), signal: "sda", color: "#2F7FD8", lane: 2 },
  { id: "w4", from: p("board-1", "l16"), to: p("sensor-bme280", "scl"), signal: "scl", color: "#D9962F", lane: 3 },
  { id: "w5", from: p("sensor-bme280", "vin"), to: p("display-oled", "vcc"), signal: "power", color: "#E15B4F", lane: 0 },
  { id: "w6", from: p("sensor-bme280", "gnd"), to: p("display-oled", "gnd"), signal: "gnd", color: "#41464F", lane: 1 },
  { id: "w7", from: p("sensor-bme280", "sda"), to: p("display-oled", "sda"), signal: "sda", color: "#2F7FD8", lane: 2 },
  { id: "w8", from: p("sensor-bme280", "scl"), to: p("display-oled", "scl"), signal: "scl", color: "#D9962F", lane: 3 },
  { id: "w9", from: p("board-1", "r6"), to: p("resistor-1", "p1"), signal: "gpio", color: "#3B9A68", lane: 0 },
  { id: "w10", from: p("resistor-1", "p2"), to: p("led-1", "a"), signal: "gpio", color: "#3B9A68", lane: 0 },
  { id: "w11", from: p("led-1", "k"), to: p("board-1", "r0"), signal: "gnd", color: "#41464F", lane: 0 },
];

export const initialFiles: Record<string, string> = {
  "main.py": "# main.py — Environment monitor\n# ESP32-S3 DevKitC-1 · BME280 · SSD1306\nimport time\nimport machine\n\nfrom sensors import BME280\nfrom display import SSD1306\n\nI2C_SDA = 8\nI2C_SCL = 9\nSAMPLE_INTERVAL_MS = 2000\nMQTT_TOPIC = \"aether/env-monitor\"\n\ni2c = machine.I2C(\n    0,\n    sda=machine.Pin(I2C_SDA),\n    scl=machine.Pin(I2C_SCL),\n    freq=400_000,\n)\nsensor = BME280(i2c, address=0x76)\ndisplay = SSD1306(i2c, width=128, height=64)\nled = machine.Pin(2, machine.Pin.OUT)\n\n\ndef read_environment():\n    reading = sensor.read()\n    return {\n        \"temperature\": round(reading.temperature, 1),\n        \"humidity\": round(reading.humidity, 1),\n        \"pressure\": round(reading.pressure, 1),\n    }\n\n\ndef render(data):\n    display.fill(0)\n    display.text(\"ENV MONITOR\", 0, 0)\n    display.text(f\"{data['temperature']:.1f} C\", 0, 18)\n    display.text(f\"{data['humidity']:.1f} %RH\", 0, 34)\n    display.text(f\"{data['pressure']:.0f} hPa\", 0, 48)\n    display.show()\n\n\ndef main():\n    print(\"BME280 initialized\")\n    print(\"SSD1306 display initialized\")\n    sample = 0\n    while True:\n        data = read_environment()\n        render(data)\n        led.value(not led.value())\n        print(f\"T={data['temperature']:.1f}C RH={data['humidity']:.1f}%\")\n        sample += 1\n        time.sleep_ms(SAMPLE_INTERVAL_MS)\n\n\nif __name__ == \"__main__\":\n    main()\n",
  "sensors.py": "# sensors.py — BME280 driver\n# Minimal I²C driver for the Bosch BME280\nimport struct\nimport time\n\n\nclass BME280:\n    ADDR = 0x76\n\n    REG_ID = 0xD0\n    REG_CTRL_HUM = 0xF2\n    REG_CTRL_MEAS = 0xF4\n    REG_CONFIG = 0xF5\n    REG_DATA = 0xF7\n\n    def __init__(self, i2c, address=ADDR):\n        self.i2c = i2c\n        self.address = address\n        self._verify()\n\n    def _verify(self):\n        chip_id = self.i2c.readfrom_mem(self.address, self.REG_ID, 1)[0]\n        if chip_id != 0x60:\n            raise OSError(\"BME280 not found at 0x%02X\" % self.address)\n        self.i2c.writeto_mem(self.address, self.REG_CTRL_HUM, b\"\x01\")\n        self.i2c.writeto_mem(self.address, self.REG_CONFIG, b\"\xA0\")\n        self.i2c.writeto_mem(self.address, self.REG_CTRL_MEAS, b\"\x27\")\n\n    def read(self):\n        raw = self.i2c.readfrom_mem(self.address, self.REG_DATA, 6)\n        return Reading(\n            pressure=self._pressure(raw[0:3]),\n            temperature=self._temperature(raw[3:6]),\n            humidity=48.2,\n        )\n\n    def _temperature(self, data):\n        raw = (data[0] << 12) | (data[1] << 4) | (data[2] >> 4)\n        return 24.6 + (raw % 100) / 500\n\n    def _pressure(self, data):\n        raw = (data[0] << 12) | (data[1] << 4) | (data[2] >> 4)\n        return 1013.2 + (raw % 40) / 100\n\n\nclass Reading:\n    def __init__(self, temperature, humidity, pressure):\n        self.temperature = temperature\n        self.humidity = humidity\n        self.pressure = pressure\n",
  "config.json": "{\n  \"project\": \"Smart Environment Monitor\",\n  \"board\": \"esp32-s3-devkitc-1\",\n  \"firmware\": \"micropython\",\n  \"i2c\": {\n    \"bus\": 0,\n    \"sda\": 8,\n    \"scl\": 9,\n    \"frequency\": 400000\n  },\n  \"sampling\": {\n    \"interval_ms\": 2000,\n    \"samples_per_report\": 30\n  },\n  \"display\": {\n    \"driver\": \"ssd1306\",\n    \"width\": 128,\n    \"height\": 64,\n    \"address\": \"0x3C\"\n  },\n  \"network\": {\n    \"ssid\": \"AetherLab\",\n    \"mqtt_broker\": \"mqtt://aether.local\",\n    \"topic\": \"aether/env-monitor\"\n  }\n}\n",
  "circuit.json": "{\n  \"version\": 3,\n  \"board\": \"esp32-s3-devkitc-1\",\n  \"nets\": [\n    { \"name\": \"3V3\", \"pins\": [\"U1.3V3\", \"U2.VIN\", \"DS1.VCC\"], \"color\": \"#E15B4F\" },\n    { \"name\": \"GND\", \"pins\": [\"U1.GND\", \"U2.GND\", \"DS1.GND\", \"D1.K\"], \"color\": \"#41464F\" },\n    { \"name\": \"SDA\", \"pins\": [\"U1.IO8\", \"U2.SDA\", \"DS1.SDA\"], \"color\": \"#2F7FD8\" },\n    { \"name\": \"SCL\", \"pins\": [\"U1.IO9\", \"U2.SCL\", \"DS1.SCL\"], \"color\": \"#D9962F\" },\n    { \"name\": \"LED\", \"pins\": [\"U1.IO2\", \"R1.1\"], \"color\": \"#3B9A68\" }\n  ],\n  \"components\": [\n    { \"ref\": \"U1\", \"part\": \"esp32-s3-devkitc-1\", \"x\": 466, \"y\": 176 },\n    { \"ref\": \"U2\", \"part\": \"bme280\", \"x\": 172, \"y\": 388 },\n    { \"ref\": \"DS1\", \"part\": \"ssd1306-096\", \"x\": 160, \"y\": 140 },\n    { \"ref\": \"R1\", \"part\": \"resistor-220\", \"x\": 782, \"y\": 358 },\n    { \"ref\": \"D1\", \"part\": \"led-5mm-red\", \"x\": 892, \"y\": 348 }\n  ]\n}\n",
  "README.md": "# Smart Environment Monitor\n\nA bench prototype that samples temperature, humidity and pressure every\ntwo seconds and renders the values on a 0.96\" OLED.\n\n## Hardware\n\n- ESP32-S3 DevKitC-1 (N8R2)\n- Bosch BME280 breakout (I²C, 0x76)\n- SSD1306 OLED, 128 × 64 (I²C, 0x3C)\n- 5 mm red LED + 220 Ω resistor\n\n## Wiring\n\n| Signal | ESP32-S3 | Peripheral |\n| ------ | -------- | ---------- |\n| 3V3    | 3V3      | BME280 VIN, OLED VCC |\n| GND    | GND      | BME280 GND, OLED GND, LED K |\n| SDA    | GPIO 8   | BME280 SDA, OLED SDA |\n| SCL    | GPIO 9   | BME280 SCL, OLED SCL |\n| LED    | GPIO 2   | R1 to D1 anode |\n\n## Run\n\nOpen Simulation, then press Run Simulation. Serial output is available\non COM3 at 115200 baud.\n\n> Aether Agent keeps the firmware and circuit in sync. Review generated\n> patches before deploying to physical hardware.\n",
};


export const projects: ProjectMeta[] = [
  {
    "id": "env-monitor",
    "name": "Smart Environment Monitor",
    "description": "Indoor climate node with BME280 sensing and an I²C OLED readout.",
    "board": "ESP32-S3 DevKitC-1",
    "updated": "Edited 2 min ago",
    "accent": "#007AFF",
    "template": "Environment monitor"
  },
  {
    "id": "air-node",
    "name": "Air Quality Node",
    "description": "Portable PM2.5 and VOC monitor with an MQTT uplink.",
    "board": "ESP32-S3 DevKitC-1",
    "updated": "Yesterday",
    "accent": "#2F7FD8",
    "template": "Air quality"
  },
  {
    "id": "plant-waterer",
    "name": "Smart Plant Waterer",
    "description": "Capacitive soil sensing with a pump driver and deep-sleep schedule.",
    "board": "Arduino Nano ESP32",
    "updated": "Oct 18",
    "accent": "#3B9A68",
    "template": "Plant waterer"
  }
];

export const initialSerial: SerialLine[] = [
  {
    "id": "s1",
    "time": "12:04:31.104",
    "level": "info",
    "text": "BME280 initialized · addr 0x76 · chip id 0x60"
  },
  {
    "id": "s2",
    "time": "12:04:31.281",
    "level": "info",
    "text": "I²C bus 0 ready · GPIO 8 (SDA) / GPIO 9 (SCL) · 400 kHz"
  },
  {
    "id": "s3",
    "time": "12:04:31.476",
    "level": "success",
    "text": "SSD1306 display initialized · 128×64 · addr 0x3C"
  },
  {
    "id": "s4",
    "time": "12:04:32.020",
    "level": "info",
    "text": "Temperature: 24.6 °C   Humidity: 48.2 %   1013.2 hPa"
  },
  {
    "id": "s5",
    "time": "12:04:32.043",
    "level": "info",
    "text": "OLED updated successfully · frame 1 · 11 ms"
  },
  {
    "id": "s6",
    "time": "12:04:33.512",
    "level": "data",
    "text": "Wi-Fi connected · AetherLab · RSSI −48 dBm · 192.168.1.42"
  },
  {
    "id": "s7",
    "time": "12:04:33.890",
    "level": "success",
    "text": "MQTT connected · mqtt://aether.local:1883 · QoS 1"
  },
  {
    "id": "s8",
    "time": "12:04:34.022",
    "level": "info",
    "text": "Temperature: 24.6 °C   Humidity: 48.2 %   1013.2 hPa"
  },
  {
    "id": "s9",
    "time": "12:04:34.048",
    "level": "info",
    "text": "OLED updated successfully · frame 2 · 8 ms"
  },
  {
    "id": "s10",
    "time": "12:04:35.110",
    "level": "data",
    "text": "sample → aether/env-monitor · 62 B · 42 ms"
  },
  {
    "id": "s11",
    "time": "12:04:35.318",
    "level": "warn",
    "text": "I²C clock stretch 1.8 ms exceeds 1.0 ms budget (recovered)"
  }
];

export const initialConsole: ConsoleLine[] = [
  {
    "id": "c1",
    "source": "Build",
    "text": "MicroPython v1.23.0 · ESP32-S3 (N8R2) · 8 MB flash",
    "tone": "muted"
  },
  {
    "id": "c2",
    "source": "Build",
    "text": "Compiled firmware in 1.42 s · 0 errors, 2 warnings",
    "tone": "normal"
  },
  {
    "id": "c3",
    "source": "Simulator",
    "text": "Virtual board attached · /dev/tty.usbserial-1420",
    "tone": "muted"
  },
  {
    "id": "c4",
    "source": "Simulator",
    "text": "Peripherals resolved: BME280 0x76, SSD1306 0x3C",
    "tone": "normal"
  },
  {
    "id": "c5",
    "source": "Agent",
    "text": "Verified 30 samples · 0 dropped frames · 2 warnings",
    "tone": "success"
  }
];

export const initialAgentMessages: AgentMessage[] = [
  {
    "id": "m1",
    "role": "user",
    "time": "12:04",
    "text": "帮我使用 ESP32-S3 和 BME280 搭建一个环境监测系统，每 2 秒采样一次，并将数据显示到 OLED。"
  },
  {
    "id": "m2",
    "role": "agent",
    "time": "12:04",
    "text": "I wired the BME280 and the SSD1306 onto a shared I²C bus, generated the MicroPython firmware, and started the virtual board. Everything is running on COM3.",
    "steps": [
      {
        "id": "st1",
        "label": "Analyzed hardware requirements",
        "detail": "ESP32-S3 · BME280 · SSD1306",
        "state": "done"
      },
      {
        "id": "st2",
        "label": "Added BME280 sensor",
        "detail": "BME280 @ 0x76",
        "state": "done"
      },
      {
        "id": "st3",
        "label": "Connected I²C bus",
        "detail": "GPIO 8 · SDA / GPIO 9 · SCL",
        "state": "done"
      },
      {
        "id": "st4",
        "label": "Generated MicroPython firmware",
        "detail": "main.py · sensors.py",
        "state": "done"
      },
      {
        "id": "st5",
        "label": "Running virtual simulation",
        "detail": "COM3 · 115200 baud",
        "state": "done"
      },
      {
        "id": "st6",
        "label": "Verification passed",
        "detail": "0 errors · 30 / 30 samples",
        "state": "done"
      }
    ],
    "refs": [
      {
        "kind": "file",
        "label": "main.py",
        "target": "main.py",
        "meta": "+34 −0"
      },
      {
        "kind": "file",
        "label": "sensors.py",
        "target": "sensors.py",
        "meta": "+58 −0"
      },
      {
        "kind": "part",
        "label": "BME280",
        "target": "sensor-bme280"
      },
      {
        "kind": "part",
        "label": "SSD1306",
        "target": "display-oled"
      }
    ],
    "summary": "Sampling at 2 s with a 400 kHz bus. Temperature and humidity are streaming to the OLED, and the status LED toggles on every sample. Two I²C clock-stretch warnings remain; the fix drops the bus to 100 kHz.",
    "actions": true,
    "live": true
  }
] as AgentMessage[];

export const initialFilesList = ["main.py", "sensors.py", "config.json", "circuit.json", "README.md"];


initialFiles["esp32_s3.board"] = `# Aether board definition · v1.3
id: esp32-s3-devkitc-1
name: ESP32-S3 DevKitC-1
mcu: ESP32-S3-WROOM-1-N8R2
architecture: xtensa-lx7
clock_hz: 240000000
flash: 8388608
psram: 2097152
usb:
  type: usb-c
  native: true
  serial_port: COM3
pins:
  i2c_sda: 8
  i2c_scl: 9
  status_led: 2
  boot: 0
`;

initialFiles["tests/check_i2c.py"] = `# tests/check_i2c.py — hardware smoke test
from machine import Pin, I2C
import time


def test_bus_scan():
    i2c = I2C(0, sda=Pin(8), scl=Pin(9), freq=400_000)
    devices = i2c.scan()
    assert 0x76 in devices, "BME280 missing"
    assert 0x3C in devices, "SSD1306 missing"
    print("I2C devices:", [hex(d) for d in devices])


def test_sample_rate():
    start = time.ticks_ms()
    for _ in range(5):
        time.sleep_ms(2000)
    elapsed = time.ticks_diff(time.ticks_ms(), start)
    assert 9900 < elapsed < 10100, "sample loop drifted"
`;

initialFilesList.push("esp32_s3.board", "tests/check_i2c.py");
