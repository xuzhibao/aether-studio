import type { ComponentKind, HwComponent } from "../../types";
import { uid } from "../../lib/utils";
import { board } from "./hardware";
const clone = structuredClone;
export function makePart(kind: ComponentKind, index: number): HwComponent {
  const base = {
    id: uid(kind),
    kind,
    x: 760 + (index % 2) * 0,
    y: 540,
    props: {} as Record<string, string>,
  };
  switch (kind) {
    case "bme280":
      return {
        ...base,
        name: "BME280 Sensor",
        reference: "U" + (2 + index),
        x: 172 + index * 24,
        y: 428,
        w: 170,
        h: 122,
        pins: [
          { id: "vin", label: "VIN", signal: "power", x: 178, y: 34, dir: "right" },
          { id: "gnd", label: "GND", signal: "gnd", x: 178, y: 54, dir: "right" },
          { id: "sda", label: "SDA", signal: "i2c", x: 178, y: 74, dir: "right" },
          { id: "scl", label: "SCL", signal: "i2c", x: 178, y: 94, dir: "right" },
        ],
        props: { Interface: "I²C", Address: "0x76", Range: "300–1100 hPa" },
      };
    case "oled":
      return {
        ...base,
        name: "OLED 0.96″",
        reference: "DS" + (1 + index),
        x: 160 + index * 24,
        y: 160,
        w: 204,
        h: 136,
        pins: [
          { id: "gnd", label: "GND", signal: "gnd", x: 48, y: 144, dir: "down" },
          { id: "vcc", label: "VCC", signal: "power", x: 88, y: 144, dir: "down" },
          { id: "scl", label: "SCL", signal: "i2c", x: 128, y: 144, dir: "down" },
          { id: "sda", label: "SDA", signal: "i2c", x: 168, y: 144, dir: "down" },
        ],
        props: { Controller: "SSD1306", Resolution: "128 × 64", Interface: "I²C · 0x3C" },
      };
    case "resistor":
      return {
        ...base,
        name: "Resistor 220 Ω",
        reference: "R" + (1 + index),
        x: 360 + (index % 3) * 24,
        y: 600,
        w: 78,
        h: 24,
        pins: [
          { id: "p1", label: "1", signal: "gpio", x: 0, y: 12, dir: "left" },
          { id: "p2", label: "2", signal: "gpio", x: 78, y: 12, dir: "right" },
        ],
        props: { Value: "220 Ω", Tolerance: "±1%", Package: "Axial" },
      };
    case "led":
      return {
        ...base,
        name: "Status LED",
        reference: "D" + (1 + index),
        x: 420 + (index % 3) * 24,
        y: 600,
        w: 44,
        h: 48,
        pins: [
          { id: "a", label: "A", signal: "gpio", x: 0, y: 24, dir: "left" },
          { id: "k", label: "K", signal: "gnd", x: 44, y: 24, dir: "right" },
        ],
        props: { Color: "Red · 625 nm", Forward: "2.0 V", Lens: "5 mm" },
      };
    case "buzzer":
      return {
        ...base,
        name: "Piezo Buzzer",
        reference: "BZ" + (1 + index),
        x: 360 + (index % 3) * 24,
        y: 588,
        w: 64,
        h: 64,
        pins: [
          { id: "p", label: "+", signal: "pwm", x: 0, y: 40, dir: "left" },
          { id: "n", label: "−", signal: "gnd", x: 64, y: 40, dir: "right" },
        ],
        props: { Voltage: "3–5 V", Frequency: "2.7 kHz", Type: "Passive" },
      };
    case "button":
      return {
        ...base,
        name: "Push Button",
        reference: "SW" + (1 + index),
        x: 420 + (index % 3) * 24,
        y: 588,
        w: 58,
        h: 58,
        pins: [
          { id: "p1", label: "1", signal: "gpio", x: 0, y: 34, dir: "left" },
          { id: "p2", label: "2", signal: "gnd", x: 58, y: 34, dir: "right" },
        ],
        props: { Type: "Momentary", Mounting: "THT", Rating: "12 V / 50 mA" },
      };
    case "dht22":
      return {
        ...base,
        name: "DHT22 Sensor",
        reference: "U" + (2 + index),
        x: 430 + (index % 2) * 24,
        y: 55,
        w: 86,
        h: 116,
        pins: [
          { id: "vcc", label: "VCC", signal: "power", x: 18, y: 124, dir: "down" },
          { id: "data", label: "DATA", signal: "gpio", x: 43, y: 124, dir: "down" },
          { id: "gnd", label: "GND", signal: "gnd", x: 68, y: 124, dir: "down" },
        ],
        props: { Interface: "1-Wire", Range: "−40–80 °C", Accuracy: "±0.5 °C" },
      };
    case "soil":
      return {
        ...base,
        name: "Soil Moisture",
        reference: "U" + (2 + index),
        x: 430 + (index % 2) * 24,
        y: 50,
        w: 96,
        h: 132,
        pins: [
          { id: "vcc", label: "VCC", signal: "power", x: 20, y: 140, dir: "down" },
          { id: "ao", label: "AO", signal: "analog", x: 48, y: 140, dir: "down" },
          { id: "gnd", label: "GND", signal: "gnd", x: 76, y: 140, dir: "down" },
        ],
        props: { Output: "Analog", Range: "0–3.0 V", Probe: "Capacitive" },
      };
    case "servo":
      return {
        ...base,
        name: "Micro Servo",
        reference: "M" + (1 + index),
        x: 420 + (index % 2) * 24,
        y: 585,
        w: 92,
        h: 92,
        pins: [
          { id: "sig", label: "SIG", signal: "pwm", x: 92, y: 58, dir: "right" },
          { id: "vcc", label: "V+", signal: "power", x: 92, y: 72, dir: "right" },
          { id: "gnd", label: "GND", signal: "gnd", x: 92, y: 86, dir: "right" },
        ],
        props: { Torque: "1.8 kg·cm", Voltage: "4.8–6 V", Signal: "PWM 50 Hz" },
      };
    default:
      return clone(board);
  }
}
