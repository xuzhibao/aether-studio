import { usePlugins } from "../../plugins/usePlugins";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CircuitBoard,
  Crosshair,
  Hand,
  Lock,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  ScanSearch,
  Spline,
  Wifi,
} from "lucide-react";
import { useStudio } from "../../store/studio";
import { clamp, cn, getPin, wireGeometry } from "../../lib/utils";
import { IconButton, Tip } from "../ui";
import { PluginPart } from "./PluginPart";
import { Inspector } from "./Inspector";
import { ComponentLibrary } from "./Library";
import type { HwComponent } from "../../types";

const SCENE_W = 1200;
const SCENE_H = 800;
const BASE_VIEW = { w: 820, h: 540 };

function Defs() {
  return (
    <defs>
      <filter id="softBlur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3.8" />
      </filter>
      <filter id="ledGlow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur stdDeviation="4" />
      </filter>
      <linearGradient id="pcbGrad" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stopColor="#1C232A" />
        <stop offset="1" stopColor="#11151A" />
      </linearGradient>
      <linearGradient id="metalGrad" x1="0" y1="0" x2="0.9" y2="1">
        <stop offset="0" stopColor="#CDD3D9" />
        <stop offset="0.28" stopColor="#A8B0B8" />
        <stop offset="0.55" stopColor="#D4DADF" />
        <stop offset="0.8" stopColor="#8F979F" />
        <stop offset="1" stopColor="#B8BFC6" />
      </linearGradient>
      <radialGradient id="goldGrad" cx="0.35" cy="0.3" r="0.8">
        <stop offset="0" stopColor="#F2DA9E" />
        <stop offset="0.45" stopColor="#D5B46A" />
        <stop offset="1" stopColor="#9A7C37" />
      </radialGradient>
      <linearGradient id="sensorPcb" x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0" stopColor="#263A54" />
        <stop offset="1" stopColor="#1B2A3E" />
      </linearGradient>
      <linearGradient id="oledPcb" x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0" stopColor="#1B2027" />
        <stop offset="1" stopColor="#101419" />
      </linearGradient>
      <linearGradient id="resistorBody" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#E4D4AE" />
        <stop offset="0.55" stopColor="#D2BF95" />
        <stop offset="1" stopColor="#B9A57B" />
      </linearGradient>
      <radialGradient id="ledOn" cx="0.35" cy="0.28" r="0.75">
        <stop offset="0" stopColor="#FFE3D9" />
        <stop offset="0.28" stopColor="#FF8A72" />
        <stop offset="0.62" stopColor="#F04D3B" />
        <stop offset="1" stopColor="#A4271D" />
      </radialGradient>
      <radialGradient id="ledOff" cx="0.35" cy="0.3" r="0.75">
        <stop offset="0" stopColor="#B97063" />
        <stop offset="0.5" stopColor="#8C4037" />
        <stop offset="1" stopColor="#5C2923" />
      </radialGradient>
      <radialGradient id="oledGlow" cx="0.5" cy="0.4" r="0.8">
        <stop offset="0" stopColor="#0A3A46" />
        <stop offset="1" stopColor="#04121A" />
      </radialGradient>
      <linearGradient id="screenGlass" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.1" />
        <stop offset="0.32" stopColor="#FFFFFF" stopOpacity="0.015" />
        <stop offset="0.7" stopColor="#FFFFFF" stopOpacity="0.035" />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.005" />
      </linearGradient>
    </defs>
  );
}

function SelectionOverlay({ comp }: { comp: HwComponent }) {
  const label = comp.name + "  ·  " + comp.reference;
  const width = Math.max(52, label.length * 4.15 + 14);
  return (
    <g pointerEvents="none">
      <rect x={comp.x - 6} y={comp.y - 6} width={comp.w + 12} height={comp.h + 12} rx={9} fill="none" stroke="#007AFF" strokeWidth={1.15} opacity={0.92} />
      {[
        [comp.x - 6, comp.y - 6],
        [comp.x + comp.w + 6, comp.y - 6],
        [comp.x - 6, comp.y + comp.h + 6],
        [comp.x + comp.w + 6, comp.y + comp.h + 6],
      ].map(([x, y], i) => (
        <rect key={i} x={x - 3} y={y - 3} width={6} height={6} rx={1.4} fill="#fff" stroke="#007AFF" strokeWidth={1} />
      ))}
      <g transform={"translate(" + (comp.x - 6) + "," + (comp.y - 29) + ")"}>
        <rect width={width} height={19} rx={4.5} fill="#007AFF" />
        <text x={7} y={13} fontSize={8} fontWeight={550} fill="#fff" className="svg-ui">
          {label}
        </text>
      </g>
    </g>
  );
}

function WirePreview({ start, zoom, pan }: { start: { comp: string; pin: string }; zoom: number; pan: { x: number; y: number } }) {
  const containerRef = useRef<SVGSVGElement>(null);
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const components = useStudio((s) => s.components);

  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const startComp = components.find((c) => c.id === start.comp);
    const pin = startComp ? getPin(startComp, start.pin) : undefined;
    if (!startComp || !pin) return;
    const overlay = document.getElementById("circuit-scene");
    const group = document.getElementById("scene-group");
    if (!overlay || !group) return;
    const rect = parent.getBoundingClientRect();
    const matrix = (group as unknown as SVGGraphicsElement).getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(startComp.x + pin.x, startComp.y + pin.y).matrixTransform(matrix);
    const onMove = (event: PointerEvent) => {
      setLine({ x1: point.x - rect.left, y1: point.y - rect.top, x2: event.clientX - rect.left, y2: event.clientY - rect.top });
    };
    onMove(new PointerEvent("pointermove", { clientX: rect.left + rect.width * 0.55, clientY: rect.top + rect.height * 0.5 }));
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [components, start, zoom, pan]);

  if (!line) return null;
  const dx = Math.max(40, Math.abs(line.x2 - line.x1) * 0.42);
  return (
    <svg ref={containerRef} className="pointer-events-none absolute inset-0 z-10 h-full w-full">
      <path
        d={"M " + line.x1 + " " + line.y1 + " C " + (line.x1 - dx) + " " + line.y1 + ", " + (line.x2 + dx) + " " + line.y2 + ", " + line.x2 + " " + line.y2}
        fill="none"
        stroke="#007AFF"
        strokeWidth={1.4}
        strokeDasharray="4 3"
        opacity={0.8}
      />
      <circle cx={line.x1} cy={line.y1} r={4} fill="#fff" stroke="#007AFF" strokeWidth={1.5} />
      <circle cx={line.x2} cy={line.y2} r={3} fill="#007AFF" opacity={0.75} />
    </svg>
  );
}

export function CircuitCanvas() {
  const registry = usePlugins();
  const {
    components,
    wires,
    selectedId,
    selectedPin,
    tool,
    viewMode,
    wireStart,
    zoom,
    pan,
    runState,
    readings,
    ledOn,
    selectComponent,
    selectPin,
    moveComponent,
    setTool,
    setViewMode,
    setZoom,
    setPan,
    resetView,
    completeWire,
    startWire,
    cancelWire,
    setLibraryOpen,
    libraryOpen,
  } = useStudio();

  const groupRef = useRef<SVGGElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  const view = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    components.forEach((c) => {
      const xs = [c.x, c.x + c.w, ...c.pins.map((p) => c.x + p.x)];
      const ys = [c.y, c.y + c.h, ...c.pins.map((p) => c.y + p.y)];
      minX = Math.min(minX, ...xs);
      minY = Math.min(minY, ...ys);
      maxX = Math.max(maxX, ...xs);
      maxY = Math.max(maxY, ...ys);
    });
    if (!Number.isFinite(minX)) return { x: 140, y: 90, w: 820, h: 540 };
    const margin = 34;
    minX -= margin;
    minY -= margin;
    maxX += 62;
    maxY += margin + 4;
    const w = Math.max(BASE_VIEW.w, maxX - minX);
    const h = Math.max(BASE_VIEW.h, maxY - minY);
    return { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
  }, [components]);
  const viewRef = useRef(view);
  viewRef.current = view;

  const toScene = useCallback((clientX: number, clientY: number) => {
    const matrix = groupRef.current?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setSpaceDown(true);
      }
      if (e.key === "Escape") cancelWire();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [cancelWire]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = useStudio.getState();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const q = toScene(e.clientX, e.clientY);
        const next = clamp(state.zoom * Math.exp(-e.deltaY * 0.0016), 0.6, 2);
        state.setZoom(next);
        const current = viewRef.current;
        state.setPan({
          x: state.pan.x + (state.zoom - next) * (q.x - (current.x + current.w / 2)),
          y: state.pan.y + (state.zoom - next) * (q.y - (current.y + current.h / 2)),
        });
      } else {
        state.setPan({
          x: state.pan.x - e.deltaX * 0.75,
          y: state.pan.y - e.deltaY * 0.75,
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toScene]);

  const beginDrag = (event: React.PointerEvent, comp: HwComponent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    selectComponent(comp.id);
    if (tool === "wire" || spaceDown) return;
    const startPoint = toScene(event.clientX, event.clientY);
    const origin = { x: comp.x, y: comp.y };
    let moved = false;
    setDraggingId(comp.id);
    const move = (e: PointerEvent) => {
      const p = toScene(e.clientX, e.clientY);
      const nx = Math.round((origin.x + p.x - startPoint.x) / 2) * 2;
      const ny = Math.round((origin.y + p.y - startPoint.y) / 2) * 2;
      if (Math.abs(nx - origin.x) > 1 || Math.abs(ny - origin.y) > 1) moved = true;
      moveComponent(comp.id, clamp(nx, -60, SCENE_W - 40), clamp(ny, -20, SCENE_H - 40));
    };
    const up = () => {
      setDraggingId(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        useStudio.setState({ dirty: true });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onBackgroundDown = (event: React.PointerEvent) => {
    if (event.button === 2) return;
    if (tool === "wire") {
      cancelWire();
      return;
    }
    const start = { x: event.clientX, y: event.clientY };
    const origin = useStudio.getState().pan;
    let moved = false;
    if (spaceDown || event.button === 1) {
      event.preventDefault();
      setPanning(true);
      const move = (e: PointerEvent) => {
        moved = true;
        setPan({ x: origin.x + e.clientX - start.x, y: origin.y + e.clientY - start.y });
      };
      const up = () => {
        setPanning(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    selectComponent(null);
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true;
        setPan({ x: origin.x + dx, y: origin.y + dy });
      }
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // plain background click deselects; panning requires space / middle mouse / wheel
    void moved;
    window.addEventListener("pointerup", up);
  };

  const connectedPins = wires.reduce<Record<string, string>>((map, wire) => {
    if (wire.from.comp === "board-1") map[wire.from.pin] = wire.color;
    if (wire.to.comp === "board-1") map[wire.to.pin] = wire.color;
    return map;
  }, {});
  const selected = components.find((c) => c.id === selectedId) ?? null;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const sceneTransform = "translate(" + (cx + pan.x) + " " + (cy + pan.y) + ") scale(" + zoom + ") translate(" + (-cx) + " " + (-cy) + ")";

  return (
    <div
      ref={canvasRef}
      className={cn("dot-grid canvas-vignette relative h-full w-full overflow-hidden", spaceDown ? "cursor-grab" : panning ? "cursor-grabbing" : "")}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg id="circuit-scene" onPointerDown={onBackgroundDown} viewBox={view.x + " " + view.y + " " + view.w + " " + view.h} className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
        <Defs />
        <g ref={groupRef} id="scene-group" transform={sceneTransform}>
          <g pointerEvents="none">
            {wires.map((wire) => {
              const geo = wireGeometry(wire, components);
              if (!geo.d) return null;
              return (
                <g key={wire.id}>
                  <path d={geo.d} fill="none" stroke="rgba(19,27,40,0.08)" strokeWidth={3.6} strokeLinecap="round" transform="translate(0 1.3)" />
                  <path d={geo.d} fill="none" stroke="#F7F8FA" strokeWidth={2.8} strokeLinecap="round" opacity={0.9} />
                  <path d={geo.d} fill="none" stroke={wire.color} strokeWidth={1.6} strokeLinecap="round" />
                </g>
              );
            })}
            {Array.from(
              wires.reduce((map, wire) => {
                const geo = wireGeometry(wire, components);
                if (!geo.d) return map;
                [geo.from, geo.to].forEach((point) => {
                  const key = Math.round(point.x) + ":" + Math.round(point.y);
                  const existing = map.get(key);
                  map.set(key, { count: (existing?.count ?? 0) + 1, color: wire.color, point });
                });
                return map;
              }, new Map<string, { count: number; color: string; point: { x: number; y: number } }>()),
            )
              .filter(([, value]) => value.count > 1)
              .map(([key, value]) => (
                <circle key={key} cx={value.point.x} cy={value.point.y} r={3.5} fill={value.color} stroke="#fff" strokeWidth={1.1} />
              ))}
          </g>

          {components.map((comp) => {
            const common = {
              key: comp.id,
              className: "scene-part",
              onPointerDown: (e: React.PointerEvent) => beginDrag(e, comp),
            };
            const pinHandler = (pinId: string) => {
              if (tool === "wire") {
                if (!wireStart) startWire(comp.id, pinId);
                else if (wireStart.comp === comp.id && wireStart.pin === pinId) cancelWire();
                else completeWire(comp.id, pinId);
              } else {
                selectPin(comp.id, pinId);
              }
            };
            return (
              <g
                key={comp.id}
                data-component-id={comp.id}
                data-component-kind={comp.kind}
                className={cn("scene-part", draggingId === comp.id && "dragging", tool === "wire" && "cursor-crosshair")}
                transform={"translate(" + comp.x + " " + comp.y + ")"}
                onPointerDown={(e) => beginDrag(e, comp)}
              >
                <PluginPart comp={comp} schematic={viewMode === "schematic"} onPinClick={pinHandler} selectedPin={selectedPin} running={runState === "running"} connected={connectedPins} readings={readings} on={ledOn} />
              </g>
            );
          })}

          {selected && viewMode === "board" && <SelectionOverlay comp={selected} />}
          {selected && viewMode === "schematic" && <SelectionOverlay comp={selected} />}
        </g>
      </svg>

      {wireStart && <WirePreview start={wireStart} zoom={zoom} pan={pan} />}

      <div className="pointer-events-none absolute left-4 top-3 flex items-center gap-1.5 rounded-[6px] bg-[#F7F8FA]/88 px-2 py-1 backdrop-blur-[2px]">
        <span className="text-[10.5px] font-[560] tracking-[-0.01em] text-[#41464D]">Environment Bench</span>
        <span className="text-[9.5px] text-[#B0B5BC]">·</span>
        <span className="text-[10px] text-[#7D848C]">Rev A</span>
        <Lock size={10} className="ml-0.5 text-[#949BA3]" />
        <span className="text-[10px] text-[#A8ADB4]">·</span>
        <span className="text-[10px] text-[#7D848C]">{components.length} components · {new Set(wires.map((wire) => wire.signal)).size} nets</span>
      </div>

      <div className="canvas-toolbar absolute right-3 top-3 z-20 flex items-center gap-0.5 p-1">
        <Tip label="Select · V">
          <button className={cn("flex h-[27px] w-[27px] items-center justify-center rounded-[6px] text-[#666C74] hover:bg-[#F0F2F4] hover:text-[#1D1D1F]", tool === "select" && "bg-[#EDF3FC] text-[#007AFF] hover:bg-[#EDF3FC] hover:text-[#007AFF]")} onClick={() => setTool("select")}>
            <MousePointer2 size={13.5} strokeWidth={1.8} />
          </button>
        </Tip>
        <Tip label="Wire · W">
          <button className={cn("flex h-[27px] w-[27px] items-center justify-center rounded-[6px] text-[#666C74] hover:bg-[#F0F2F4] hover:text-[#1D1D1F]", tool === "wire" && "bg-[#EDF3FC] text-[#007AFF] hover:bg-[#EDF3FC] hover:text-[#007AFF]")} onClick={() => { setTool("wire"); setLibraryOpen(false); }}>
            <Spline size={14} strokeWidth={1.7} />
          </button>
        </Tip>
        <Tip label="Add component · A">
          <button className={cn("flex h-[27px] w-[27px] items-center justify-center rounded-[6px] text-[#666C74] hover:bg-[#F0F2F4] hover:text-[#1D1D1F]", libraryOpen && "bg-[#EDF3FC] text-[#007AFF] hover:bg-[#EDF3FC] hover:text-[#007AFF]")} onClick={() => { setTool("add"); setLibraryOpen(!libraryOpen); }}>
            <Plus size={15} strokeWidth={1.9} />
          </button>
        </Tip>
        <Tip label="Inspect · I">
          <button className={cn("flex h-[27px] w-[27px] items-center justify-center rounded-[6px] text-[#666C74] hover:bg-[#F0F2F4] hover:text-[#1D1D1F]", tool === "inspect" && "bg-[#EDF3FC] text-[#007AFF] hover:bg-[#EDF3FC] hover:text-[#007AFF]")} onClick={() => { setTool("inspect"); setLibraryOpen(false); selectComponent(selectedId ?? "board-1"); }}>
            <ScanSearch size={14} strokeWidth={1.7} />
          </button>
        </Tip>
        <div className="mx-1 h-[17px] w-px bg-[#E7E9EC]" />
        <div className="flex items-center gap-0.5">
          <button onClick={() => setViewMode("board")} className={cn("flex h-[23px] items-center gap-1 rounded-[4.5px] px-1.5 text-[9.5px] font-medium text-[#8A9098] transition-colors", viewMode === "board" && "bg-[#E8F1FD] text-[#1C64B6]")}>
            <Box size={10.5} /> Board
          </button>
          <button onClick={() => setViewMode("schematic")} className={cn("flex h-[23px] items-center gap-1 rounded-[4.5px] px-1.5 text-[9.5px] font-medium text-[#8A9098] transition-colors", viewMode === "schematic" && "bg-[#E8F1FD] text-[#1C64B6]")}>
            <CircuitBoard size={10.5} /> Schematic
          </button>
        </div>
      </div>

      <div className="canvas-toolbar absolute bottom-3.5 left-3.5 z-20 flex h-[29px] items-center gap-0.5 px-1">
        <button className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-[#6C727A] hover:bg-[#F0F2F4]" onClick={() => setZoom(zoom - 0.1)} aria-label="Zoom out">
          <Minus size={12} />
        </button>
        <button className="h-[22px] min-w-[44px] rounded-[5px] px-1 text-[9.5px] tabular text-[#5E646C] hover:bg-[#F0F2F4]" onClick={resetView}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-[#6C727A] hover:bg-[#F0F2F4]" onClick={() => setZoom(zoom + 0.1)} aria-label="Zoom in">
          <Plus size={12} />
        </button>
        <div className="mx-0.5 h-[15px] w-px bg-[#E7E9EC]" />
        <Tip label="Fit to view" side="top">
          <button className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-[#6C727A] hover:bg-[#F0F2F4]" onClick={resetView}>
            <Maximize2 size={11.5} />
          </button>
        </Tip>
        <Tip label="Pan canvas · hold Space" side="top">
          <button className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-[#8B9199] hover:bg-[#F0F2F4]">
            <Hand size={11.5} />
          </button>
        </Tip>
      </div>

      {tool === "wire" && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-[7px] border border-[#CFE2FA] bg-[#F3F8FF]/95 px-2.5 py-1.5 text-[10px] text-[#2F6BA8] shadow-sm backdrop-blur">
          {wireStart ? "Select a destination pin · Esc to cancel" : "Select a pin to start a connection"}
        </div>
      )}

      {registry.all("overlays").map(({ id, render: Render }) => <Render key={id} readings={readings} running={runState === "running"} />)}

      {libraryOpen && <ComponentLibrary />}
      {!libraryOpen && selected && <Inspector comp={selected} />}
    </div>
  );
}
