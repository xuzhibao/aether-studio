import type { HwComponent, Pin, Wire } from "../../types";

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
    "USB-C": "Native USB 1.1 · Demo only",
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
