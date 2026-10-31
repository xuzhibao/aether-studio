import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { HwComponent, Pin, Wire } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const uid = (prefix = "id") => prefix + "-" + Math.random().toString(36).slice(2, 9);

export function formatElapsed(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

const BASE_SECONDS = 12 * 3600 + 4 * 60 + 31;
export function simTime(seconds: number, ms = 0) {
  const total = BASE_SECONDS + seconds;
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":") + "." + String(ms).padStart(3, "0");
}

export function getComponent(components: HwComponent[], id: string) {
  return components.find((c) => c.id === id);
}

export function getPin(component: HwComponent, pinId: string) {
  return component.pins.find((p) => p.id === pinId);
}

export function pinPoint(component: HwComponent, pin: Pin) {
  return { x: component.x + pin.x, y: component.y + pin.y };
}

const dirVec = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
} as const;

type Pt = { x: number; y: number };

function roundedPath(points: Pt[], radius = 9) {
  const pts = points.filter((p, i) => {
    if (i === 0) return true;
    const prev = points[i - 1];
    return Math.abs(p.x - prev.x) > 0.15 || Math.abs(p.y - prev.y) > 0.15;
  });
  if (pts.length < 2) return "";
  let d = "M " + pts[0].x + " " + pts[0].y;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const outLen = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.6) {
      d += " L " + curr.x + " " + curr.y;
      continue;
    }
    const inX = curr.x - ((curr.x - prev.x) / inLen) * r;
    const inY = curr.y - ((curr.y - prev.y) / inLen) * r;
    const outX = curr.x + ((next.x - curr.x) / outLen) * r;
    const outY = curr.y + ((next.y - curr.y) / outLen) * r;
    d += " L " + inX + " " + inY + " Q " + curr.x + " " + curr.y + " " + outX + " " + outY;
  }
  const last = pts[pts.length - 1];
  d += " L " + last.x + " " + last.y;
  return d;
}

export function wireGeometry(wire: Wire, components: HwComponent[]) {
  const fromComp = getComponent(components, wire.from.comp);
  const toComp = getComponent(components, wire.to.comp);
  if (!fromComp || !toComp) return { d: "", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  const fromPin = getPin(fromComp, wire.from.pin);
  const toPin = getPin(toComp, wire.to.pin);
  if (!fromPin || !toPin) return { d: "", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };

  const p0 = pinPoint(fromComp, fromPin);
  const p2 = pinPoint(toComp, toPin);
  const v1 = dirVec[fromPin.dir];
  const v2 = dirVec[toPin.dir];
  const stub = 16;
  const p1 = { x: p0.x + v1.x * stub, y: p0.y + v1.y * stub };
  const p3 = { x: p2.x + v2.x * stub, y: p2.y + v2.y * stub };
  const lane = wire.lane ?? 0;
  const pts: Pt[] = [p0, p1];

  if (v1.y === 0 && v2.y === 0) {
    let laneX: number;
    if (v1.x < 0 && v2.x > 0) {
      laneX = p1.x - 12 - lane * 10;
    } else if (v1.x > 0 && v2.x < 0) {
      laneX = p1.x + 12 + lane * 10;
    }
    else if (v1.x > 0 && v2.x > 0) laneX = Math.max(p1.x, p3.x) + 22 + lane * 7;
    else laneX = Math.min(p1.x, p3.x) - 22 - lane * 7;
    if (Math.abs(p1.y - p3.y) < 1.2) {
      pts.push(p2);
      return { d: roundedPath(pts), from: p0, to: p2 };
    }
    pts.push({ x: laneX, y: p1.y }, { x: laneX, y: p3.y }, p3, p2);
  } else if (v1.y === 0 && v2.y !== 0) {
    const laneX = v1.x > 0 ? p0.x + 20 + lane * 7 : p0.x - 34 - lane * 9;
    const laneY = p3.y + lane * 6;
    pts.push({ x: laneX, y: p1.y }, { x: laneX, y: laneY }, { x: p3.x, y: laneY }, p3, p2);
  } else {
    pts.push(p3, p2);
  }

  return { d: roundedPath(pts), from: p0, to: p2 };
}
