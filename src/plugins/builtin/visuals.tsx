import { memo } from "react";
import type { HwComponent, Pin } from "../../types";
import { cn } from "../../lib/utils";

const MONO = '"JetBrains Mono Variable", "SF Mono", monospace';

const signalTint: Record<string, string> = {
  power: "#D98A7F",
  gnd: "#8E949C",
  i2c: "#7FB3E6",
  gpio: "#A5ABB3",
  analog: "#A79AD8",
  pwm: "#D7AC6C",
};

function PinEnd({
  pin,
  local = true,
  onPinClick,
  selected,
}: {
  pin: Pin;
  local?: boolean;
  onPinClick?: (pinId: string) => void;
  selected?: boolean;
}) {
  const endX = pin.x;
  const endY = pin.y;
  const padX = pin.dir === "left" ? 11 : pin.dir === "right" ? -11 : 0;
  const padY = pin.dir === "down" ? -11 : pin.dir === "up" ? 11 : 0;
  return (
    <g>
      <line x1={endX} y1={endY} x2={endX + padX} y2={endY + padY} stroke="#C6A65C" strokeWidth={1.15} opacity={0.78} />
      <circle cx={endX + padX} cy={endY + padY} r={3.7} fill="url(#goldGrad)" stroke="#8C7437" strokeWidth={0.5} />
      <circle cx={endX + padX} cy={endY + padY} r={1.35} fill="#0B0E11" />
      <circle cx={endX} cy={endY} r={2.15} fill="#C9A961" stroke="#12161A" strokeWidth={0.55} />
      {onPinClick && (
        <circle
          className="pin-hit"
          cx={endX}
          cy={endY}
          r={8.5}
          fill={selected ? "rgba(0,122,255,0.16)" : "transparent"}
          stroke={selected ? "#007AFF" : "transparent"}
          strokeWidth={1}
          onClick={(e) => {
            e.stopPropagation();
            onPinClick(pin.id);
          }}
        />
      )}
    </g>
  );
}

function BoardPins({ comp, onPinClick, selectedPin, connected }: { comp: HwComponent; onPinClick?: (pin: string) => void; selectedPin?: string | null; connected?: Record<string, string> }) {
  const pads = comp.pins.map((pin) => {
    const isLeft = pin.dir === "left";
    const padX = isLeft ? 11 : 225;
    const labelX = isLeft ? 22 : 214;
    const color = signalTint[pin.signal] ?? "#9AA1A9";
    const important = pin.signal === "i2c" || pin.signal === "power" || pin.signal === "gnd";
    return (
      <g key={pin.id}>
        <rect x={isLeft ? 5 : 219} y={pin.y - 6} width={12} height={12} rx={1.6} fill="#0A0C0E" stroke="#252A2F" strokeWidth={0.5} />
        <line x1={padX} y1={pin.y} x2={pin.x} y2={pin.y} stroke="#C6A65C" strokeWidth={1} opacity={0.66} />
        <circle cx={padX} cy={pin.y} r={3.65} fill="url(#goldGrad)" stroke="#8B7336" strokeWidth={0.45} />
        <circle cx={padX} cy={pin.y} r={1.3} fill="#090B0D" />
        {connected?.[pin.id] && (
          <circle
            cx={padX}
            cy={pin.y}
            r={5.4}
            fill="none"
            stroke={connected[pin.id] === "#41464F" ? "#A7AEB7" : connected[pin.id]}
            strokeWidth={0.95}
            opacity={0.95}
          />
        )}
        <text
          x={labelX}
          y={pin.y + 1.8}
          textAnchor={isLeft ? "start" : "end"}
          fontSize={6.1}
          fontWeight={important ? 600 : 500}
          fill={important ? color : "#9CA3AC"}
          opacity={important ? 0.98 : 0.92}
          className="svg-ui"
          letterSpacing={0.08}
        >
          {pin.label}
        </text>
        <circle cx={pin.x} cy={pin.y} r={2} fill="#C9A961" stroke="#11151A" strokeWidth={0.5} />
        {onPinClick && (
          <circle
            className="pin-hit"
            cx={pin.x}
            cy={pin.y}
            r={7.2}
            fill={selectedPin === pin.id ? "rgba(0,122,255,0.18)" : "transparent"}
            stroke={selectedPin === pin.id ? "#007AFF" : "transparent"}
            strokeWidth={1}
            onClick={(e) => {
              e.stopPropagation();
              onPinClick(pin.id);
            }}
          />
        )}
      </g>
    );
  });
  return <g>{pads}</g>;
}

export const BoardPart = memo(function BoardPart({
  comp,
  onPinClick,
  selectedPin,
  running,
  connected,
}: {
  comp: HwComponent;
  onPinClick?: (pin: string) => void;
  selectedPin?: string | null;
  running: boolean;
  connected?: Record<string, string>;
}) {
  return (
    <g>
      <rect x={-1} y={1} width={236} height={362} rx={11} fill="#0B0E11" opacity={0.18} filter="url(#softBlur)" />
      <rect x={0} y={0} width={236} height={360} rx={10} fill="url(#pcbGrad)" stroke="#080A0C" strokeWidth={1} />
      <rect x={0.75} y={0.75} width={234.5} height={358.5} rx={9.3} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={1} />

      {/* copper routing */}
      <g stroke="#C9A45C" strokeWidth={0.55} opacity={0.16} fill="none">
        <path d="M22 48 L44 48 L54 60 L54 74" />
        <path d="M214 62 L196 62 L184 76 L184 96" />
        <path d="M36 288 L68 288 L78 298 L78 322" />
        <path d="M200 300 L176 300 L164 312 L164 330" />
        <path d="M24 184 L54 184 L66 196" />
        <path d="M212 214 L188 214 L174 228" />
      </g>
      {/* antenna */}
      <g opacity={0.9}>
        <text x={118} y={10.5} textAnchor="middle" fontSize={5.6} fill="#8C949D" letterSpacing={0.7} className="svg-ui">
          2.4 GHz
        </text>
        <path
          d="M78 44 L78 30 L83 30 L83 39 L88 39 L88 25 L93 25 L93 40 L98 40 L98 29 L103 29 L103 43 L108 43 L108 27 L113 27 L113 38 L118 38 L118 24 L123 24 L123 42 L128 42 L128 30 L133 30 L133 40 L138 40 L138 26 L143 26 L143 44 L148 44 L148 33 L153 33 L153 44 L158 44"
          fill="none"
          stroke="#C6A75F"
          strokeWidth={1.35}
          strokeLinejoin="round"
          opacity={0.72}
        />
      </g>

      {/* RF shield */}
      <g>
        <rect x={62} y={57} width={112} height={106} rx={2.5} fill="url(#metalGrad)" stroke="#737B84" strokeWidth={0.7} />
        <rect x={64} y={59} width={108} height={102} rx={1.8} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth={0.5} />
        <g stroke="rgba(40,46,53,0.22)" strokeWidth={0.45}>
          <line x1={70} y1={64} x2={70} y2={156} />
          <line x1={78} y1={64} x2={78} y2={156} />
          <line x1={158} y1={64} x2={158} y2={156} />
          <line x1={166} y1={64} x2={166} y2={156} />
        </g>
        <text x={118} y={101} textAnchor="middle" fontSize={6.1} fontWeight={600} fill="#3D434A" letterSpacing={0.35} className="svg-ui">
          ESP32-S3-WROOM-1
        </text>
        <text x={118} y={111} textAnchor="middle" fontSize={4.7} fill="#6A727B" letterSpacing={0.5} className="svg-ui">
          Espressif
        </text>
        <g fill="#7B838C">
          {Array.from({ length: 18 }).map((_, i) => (
            <rect key={i} x={64 + i * 6} y={163} width={3.1} height={2.2} rx={0.4} />
          ))}
        </g>
      </g>

      <text x={118} y={194} textAnchor="middle" fontSize={13} fontWeight={650} fill="#DEE3E9" letterSpacing={0.9} className="svg-ui">
        ESP32-S3
      </text>
      <text x={118} y={205} textAnchor="middle" fontSize={6.8} fontWeight={500} fill="#8F97A0" letterSpacing={1.1} className="svg-ui">
        DEVKITC-1
      </text>

      {/* buttons */}
      <g>
        <rect x={63} y={232} width={30} height={20} rx={2.2} fill="url(#metalGrad)" stroke="#6C747D" strokeWidth={0.6} />
        <circle cx={78} cy={242} r={4.3} fill="#262C32" stroke="#8D959D" strokeWidth={0.5} />
        <text x={78} y={258} textAnchor="middle" fontSize={4.8} fill="#929AA3" letterSpacing={0.5} className="svg-ui">RST</text>
        <rect x={144} y={232} width={30} height={20} rx={2.2} fill="url(#metalGrad)" stroke="#6C747D" strokeWidth={0.6} />
        <circle cx={159} cy={242} r={4.3} fill="#262C32" stroke="#8D959D" strokeWidth={0.5} />
        <text x={159} y={258} textAnchor="middle" fontSize={4.8} fill="#929AA3" letterSpacing={0.5} className="svg-ui">BOOT</text>
      </g>

      {/* LEDs */}
      <g>
        <circle cx={108} cy={278} r={2} fill={running ? "#53D48A" : "#3A5A48"} />
        {running && <circle cx={108} cy={278} r={4.2} fill="#53D48A" opacity={0.14} />}
        <circle cx={128} cy={278} r={2.2} fill="#28333D" stroke="#3B4651" strokeWidth={0.5} />
      </g>

      {/* SMDs */}
      <g fill="#383F46" stroke="#20252A" strokeWidth={0.4}>
        <rect x={42} y={286} width={10} height={5} rx={0.8} />
        <rect x={56} y={286} width={7} height={4} rx={0.7} />
        <rect x={146} y={294} width={9} height={4.5} rx={0.7} />
        <rect x={160} y={294} width={6} height={3.5} rx={0.6} />
      </g>
      <g fill="#C9A45C" opacity={0.55}>
        <rect x={42} y={292.5} width={2} height={1.4} />
        <rect x={50} y={292.5} width={2} height={1.4} />
        <rect x={146} y={299.5} width={2} height={1.4} />
        <rect x={153} y={299.5} width={2} height={1.4} />
      </g>

      {/* USB-C */}
      <text x={118} y={322} textAnchor="middle" fontSize={5.6} fill="#A0A8B1" letterSpacing={0.6} className="svg-ui">USB-C</text>
      <rect x={87} y={328} width={62} height={28} rx={5.5} fill="url(#metalGrad)" stroke="#626A73" strokeWidth={0.7} />
      <rect x={91} y={331} width={54} height={4} rx={2} fill="#9EA6AE" opacity={0.45} />
      <rect x={97} y={335} width={42} height={9} rx={4.5} fill="#15191E" stroke="#3F464E" strokeWidth={0.6} />
      <rect x={91} y={347} width={54} height={2.2} rx={1} fill="#737B84" opacity={0.55} />

      {/* mounting holes */}
      <g fill="#090B0D" stroke="#2D333A" strokeWidth={0.6}>
        <circle cx={54} cy={16} r={3} />
        <circle cx={182} cy={16} r={3} />
        <circle cx={54} cy={344} r={3} />
        <circle cx={182} cy={344} r={3} />
      </g>

      <BoardPins comp={comp} onPinClick={onPinClick} selectedPin={selectedPin} connected={connected} />
    </g>
  );
});

export const SensorPart = memo(function SensorPart({
  comp,
  onPinClick,
  selectedPin,
}: {
  comp: HwComponent;
  onPinClick?: (pin: string) => void;
  selectedPin?: string | null;
}) {
  return (
    <g>
      <rect x={1} y={2} width={170} height={122} rx={8} fill="#111722" opacity={0.14} filter="url(#softBlur)" />
      <rect x={0} y={0} width={170} height={122} rx={7} fill="url(#sensorPcb)" stroke="#10151E" strokeWidth={0.9} />
      <rect x={0.7} y={0.7} width={168.6} height={120.6} rx={6.4} fill="none" stroke="rgba(255,255,255,0.065)" strokeWidth={0.8} />
      <g stroke="#CBA85D" strokeWidth={0.5} opacity={0.28} fill="none">
        <path d="M22 30 L22 96 L40 106" />
        <path d="M104 28 L104 42 L130 42 L130 56" />
        <path d="M128 94 L128 82 L148 82 L156 74" />
        <path d="M110 108 L150 108 L156 100" />
      </g>
      <g fill="#C7A75F" opacity={0.35}>
        {[24, 34, 44, 54].map((y) => (
          <circle key={y} cx={12} cy={y} r={1} />
        ))}
      </g>

      <g>
        <rect x={30} y={18} width={64} height={64} rx={5} fill="url(#metalGrad)" stroke="#767E87" strokeWidth={0.7} />
        <rect x={32} y={20} width={60} height={60} rx={4} fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth={0.55} />
        <g fill="#5B636C" opacity={0.5}>
          {Array.from({ length: 25 }).map((_, i) => (
            <circle key={i} cx={40 + (i % 5) * 11} cy={28 + Math.floor(i / 5) * 11} r={1.35} />
          ))}
        </g>
        <circle cx={62} cy={50} r={1.25} fill="#3C434B" />
        <text x={62} y={92} textAnchor="middle" fontSize={6.1} fontWeight={600} fill="#C9D0D7" letterSpacing={0.35} className="svg-ui">BME280</text>
      </g>

      <g fill="#D7DEE6" opacity={0.92} className="svg-ui">
        <text x={16} y={14} fontSize={5.2} letterSpacing={0.35}>BOSCH</text>
        <text x={44} y={112} fontSize={4.6} letterSpacing={0.25}>3.3 V · I²C</text>
        <text x={104} y={18} fontSize={5.0} fill="#A7B4C2">0x76</text>
      </g>

      <g>
        <rect x={108} y={24} width={11} height={6} rx={0.8} fill="#3A4250" stroke="#1A2028" strokeWidth={0.4} />
        <rect x={108} y={34} width={7} height={4} rx={0.6} fill="#303845" />
        <rect x={112} y={104} width={9} height={5} rx={0.7} fill="#3A4250" />
      </g>

      {/* pin header */}
      <rect x={157} y={24} width={12} height={82} rx={1.5} fill="#090C10" stroke="#222A33" strokeWidth={0.5} />
      {comp.pins.map((pin) => (
        <g key={pin.id}>
          <circle cx={163} cy={pin.y} r={3.45} fill="url(#goldGrad)" stroke="#8B7336" strokeWidth={0.45} />
          <circle cx={163} cy={pin.y} r={1.2} fill="#0A0C0F" />
          <line x1={163} y1={pin.y} x2={pin.x} y2={pin.y} stroke="#C6A65C" strokeWidth={0.9} opacity={0.7} />
          <text x={152} y={pin.y + 1.8} textAnchor="end" fontSize={6} fill="#C3CCD5" className="svg-ui" letterSpacing={0.15}>
            {pin.label}
          </text>
          <circle cx={pin.x} cy={pin.y} r={2} fill="#C9A961" stroke="#0C1015" strokeWidth={0.5} />
          {onPinClick && (
            <circle
              className="pin-hit"
              cx={pin.x}
              cy={pin.y}
              r={8}
              fill={selectedPin === pin.id ? "rgba(0,122,255,0.17)" : "transparent"}
              stroke={selectedPin === pin.id ? "#007AFF" : "transparent"}
              onClick={(e) => {
                e.stopPropagation();
                onPinClick(pin.id);
              }}
            />
          )}
        </g>
      ))}

      <g fill="#0A0C0F" opacity={0.8}>
        <circle cx={10} cy={10} r={2.3} />
        <circle cx={150} cy={10} r={2.3} />
        <circle cx={10} cy={110} r={2.3} />
        <circle cx={150} cy={110} r={2.3} />
      </g>
    </g>
  );
});

export const OledPart = memo(function OledPart({
  comp,
  readings,
  running,
  onPinClick,
  selectedPin,
}: {
  comp: HwComponent;
  readings: { temperature: number; humidity: number; pressure: number };
  running: boolean;
  onPinClick?: (pin: string) => void;
  selectedPin?: string | null;
}) {
  const t = readings.temperature.toFixed(1);
  const h = readings.humidity.toFixed(1);
  const pr = readings.pressure.toFixed(0);
  return (
    <g>
      <rect x={1} y={2} width={204} height={136} rx={8} fill="#0F1318" opacity={0.16} filter="url(#softBlur)" />
      <rect x={0} y={0} width={204} height={136} rx={7} fill="url(#oledPcb)" stroke="#0C0F13" strokeWidth={0.9} />
      <rect x={0.7} y={0.7} width={202.6} height={134.6} rx={6.4} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.8} />

      <rect x={15} y={11} width={174} height={92} rx={3.5} fill="#080A0D" stroke="#272C31" strokeWidth={1.2} />
      <rect x={19} y={15} width={166} height={84} rx={1.8} fill="#04121A" />
      <g opacity={running ? 1 : 0.62}>
        <rect x={19} y={15} width={166} height={84} fill="url(#oledGlow)" />
        <text x={27} y={28} fontSize={5.8} fill="#8FE5EA" letterSpacing={1.05} className="svg-mono" opacity={0.95}>
          ENV · MONITOR
        </text>
        <circle cx={176} cy={25.5} r={1.5} fill={running ? "#61E0A0" : "#B08A4C"} />
        {running && <circle cx={176} cy={25.5} r={3.1} fill="#61E0A0" opacity={0.18} />}
        <line x1={27} y1={33.5} x2={177} y2={33.5} stroke="#2C5A63" strokeWidth={0.55} />
        <text x={26} y={63} fontSize={19.5} fontWeight={500} fill="#EFFCFF" letterSpacing={-0.8} className="svg-mono">
          {t}
        </text>
        <text x={83} y={57} fontSize={6.2} fill="#79D7DE" className="svg-mono">°C</text>
        <text x={27} y={42} fontSize={4.7} fill="#6FA7B0" letterSpacing={0.6} className="svg-ui">TEMPERATURE</text>
        <text x={106} y={49} fontSize={8.2} fontWeight={500} fill="#DDF8FF" className="svg-mono">{h}%</text>
        <text x={106} y={57} fontSize={4.7} fill="#73AAB3" letterSpacing={0.5} className="svg-ui">HUMIDITY</text>
        <text x={106} y={70} fontSize={6.4} fill="#B8EAF0" className="svg-mono">{pr}</text>
        <text x={138} y={69} fontSize={4.9} fill="#7CB2BA" className="svg-ui">hPa</text>
        <text x={27} y={79} fontSize={5} fill="#65969E" letterSpacing={0.25} className="svg-mono">2.0 s · 400 kHz</text>
      </g>
      <rect x={19} y={15} width={166} height={84} rx={1.8} fill="url(#screenGlass)" className="oled-glass" />
      <g opacity={0.22}>
        {Array.from({ length: 8 }).map((_, i) => (
          <line key={i} x1={19} y1={21 + i * 10} x2={185} y2={21 + i * 10} stroke="#A7F0F4" strokeWidth={0.25} />
        ))}
      </g>

      <text x={18} y={115} fontSize={5.8} fill="#A3ACB5" letterSpacing={0.3} className="svg-ui">SSD1306 · 0.96″</text>

      <rect x={36} y={128} width={132} height={8} rx={1.4} fill="#090B0D" stroke="#20252A" strokeWidth={0.4} />
      {comp.pins.map((pin) => (
        <g key={pin.id}>
          <circle cx={pin.x} cy={pin.y - 4} r={3.2} fill="url(#goldGrad)" stroke="#8B7336" strokeWidth={0.4} />
          <circle cx={pin.x} cy={pin.y - 4} r={1.1} fill="#0B0E11" />
          <line x1={pin.x} y1={pin.y - 4} x2={pin.x} y2={pin.y} stroke="#C6A65C" strokeWidth={0.85} opacity={0.65} />
          <text x={pin.x} y={124} textAnchor="middle" fontSize={5.4} fill="#B5BEC7" className="svg-ui">{pin.label}</text>
          <circle cx={pin.x} cy={pin.y} r={1.9} fill="#C9A961" stroke="#0C1014" strokeWidth={0.45} />
          {onPinClick && (
            <circle
              className="pin-hit"
              cx={pin.x}
              cy={pin.y}
              r={7.5}
              fill={selectedPin === pin.id ? "rgba(0,122,255,0.18)" : "transparent"}
              stroke={selectedPin === pin.id ? "#007AFF" : "transparent"}
              onClick={(e) => {
                e.stopPropagation();
                onPinClick(pin.id);
              }}
            />
          )}
        </g>
      ))}

      <g fill="#0B0D10" opacity={0.9}>
        <circle cx={8} cy={8} r={2.2} />
        <circle cx={196} cy={8} r={2.2} />
        <circle cx={8} cy={118} r={2.2} />
        <circle cx={196} cy={118} r={2.2} />
      </g>
    </g>
  );
});

export const ResistorPart = memo(function ResistorPart({ comp, onPinClick, selectedPin }: { comp: HwComponent; onPinClick?: (pin: string) => void; selectedPin?: string | null }) {
  return (
    <g>
      <line x1={0} y1={12} x2={20} y2={12} stroke="#A9AEB4" strokeWidth={1.5} strokeLinecap="round" />
      <line x1={58} y1={12} x2={78} y2={12} stroke="#A9AEB4" strokeWidth={1.5} strokeLinecap="round" />
      <rect x={18} y={2} width={42} height={20} rx={4} fill="url(#resistorBody)" stroke="#B6A887" strokeWidth={0.7} />
      <g>
        <rect x={25} y={2.2} width={4} height={19.6} fill="#C24A3D" />
        <rect x={32} y={2.2} width={4} height={19.6} fill="#C24A3D" />
        <rect x={39} y={2.2} width={4} height={19.6} fill="#5B4635" />
        <rect x={49} y={2.2} width={3.6} height={19.6} fill="#C8A653" />
      </g>
      <path d="M20 6 Q24 2 28 6" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.9} />
      <text x={39} y={35} textAnchor="middle" fontSize={7.8} fontWeight={600} fill="#646C75" className="svg-ui" letterSpacing={0.2} paintOrder="stroke" stroke="#F7F8FA" strokeWidth={2.4}>220 Ω</text>
      {comp.pins.map((pin) => (
        <g key={pin.id}>
          <circle cx={pin.x} cy={pin.y} r={2} fill="#C9A961" stroke="#0C1014" strokeWidth={0.45} />
          {onPinClick && (
            <circle
              className="pin-hit"
              cx={pin.x}
              cy={pin.y}
              r={8}
              fill={selectedPin === pin.id ? "rgba(0,122,255,0.15)" : "transparent"}
              onClick={(e) => {
                e.stopPropagation();
                onPinClick(pin.id);
              }}
            />
          )}
        </g>
      ))}
    </g>
  );
});

export const LedPart = memo(function LedPart({ comp, on, onPinClick, selectedPin }: { comp: HwComponent; on: boolean; onPinClick?: (pin: string) => void; selectedPin?: string | null }) {
  return (
    <g>
      <line x1={0} y1={24} x2={15} y2={24} stroke="#A9AEB4" strokeWidth={1.5} strokeLinecap="round" />
      <line x1={29} y1={24} x2={44} y2={24} stroke="#A9AEB4" strokeWidth={1.5} strokeLinecap="round" />
      {on && <circle cx={22} cy={24} r={20} fill="#FF5A45" opacity={0.14} filter="url(#softBlur)" />}
      <circle cx={22} cy={24} r={13} fill={on ? "url(#ledOn)" : "url(#ledOff)"} stroke={on ? "#FF8C7A" : "#82352D"} strokeWidth={0.8} className={cn(on && "led-on")} />
      <circle cx={22} cy={24} r={10.5} fill="none" stroke={on ? "rgba(255,230,220,0.5)" : "rgba(255,190,175,0.16)"} strokeWidth={0.8} />
      <ellipse cx={17.5} cy={19} rx={4.3} ry={3.4} fill="#fff" opacity={on ? 0.5 : 0.12} transform="rotate(-24 17.5 19)" />
      <path d="M19 38 L22 32 L25 38" fill="none" stroke="#9CA3AA" strokeWidth={1} strokeLinecap="round" />
      <text x={22} y={57} textAnchor="middle" fontSize={7} fontWeight={600} fill="#646C75" className="svg-ui" letterSpacing={0.2} paintOrder="stroke" stroke="#F7F8FA" strokeWidth={2.4}>D1 · LED</text>
      {comp.pins.map((pin) => (
        <g key={pin.id}>
          <circle cx={pin.x} cy={pin.y} r={2} fill="#C9A961" stroke="#0C1014" strokeWidth={0.45} />
          {onPinClick && (
            <circle
              className="pin-hit"
              cx={pin.x}
              cy={pin.y}
              r={8}
              fill={selectedPin === pin.id ? "rgba(0,122,255,0.15)" : "transparent"}
              onClick={(e) => {
                e.stopPropagation();
                onPinClick(pin.id);
              }}
            />
          )}
        </g>
      ))}
    </g>
  );
});

function PeripheralPins({ comp, onPinClick, selectedPin }: { comp: HwComponent; onPinClick?: (p: string) => void; selectedPin?: string | null }) {
  return (
    <g>
      {comp.pins.map((pin) => {
        const labelX = pin.dir === "left" ? pin.x + 12 : pin.dir === "right" ? pin.x - 12 : pin.x;
        const labelY = pin.dir === "down" ? pin.y - 16 : pin.dir === "up" ? pin.y + 15 : pin.y + 1.6;
        const anchor = pin.dir === "left" ? "start" : pin.dir === "right" ? "end" : "middle";
        const padX = pin.dir === "left" ? 12 : pin.dir === "right" ? -12 : 0;
        const padY = pin.dir === "down" ? -12 : pin.dir === "up" ? 11 : 0;
        return (
          <g key={pin.id}>
            <line x1={pin.x} y1={pin.y} x2={pin.x + padX} y2={pin.y + padY} stroke="#C6A65C" strokeWidth={1} opacity={0.65} />
            <circle cx={pin.x + padX} cy={pin.y + padY} r={3.5} fill="url(#goldGrad)" stroke="#8B7336" strokeWidth={0.4} />
            <circle cx={pin.x + padX} cy={pin.y + padY} r={1.2} fill="#0B0E11" />
            <text x={labelX} y={labelY} textAnchor={anchor} fontSize={4.8} fill="#AAB2BB" className="svg-ui">{pin.label}</text>
            <circle cx={pin.x} cy={pin.y} r={1.9} fill="#C9A961" stroke="#0C1014" strokeWidth={0.45} />
            {onPinClick && (
              <circle
                className="pin-hit"
                cx={pin.x}
                cy={pin.y}
                r={8}
                fill={selectedPin === pin.id ? "rgba(0,122,255,0.16)" : "transparent"}
                onClick={(e) => {
                  e.stopPropagation();
                  onPinClick(pin.id);
                }}
              />
            )}
          </g>
        );
      })}
    </g>
  );
}

export function GenericPart({ comp, onPinClick, selectedPin }: { comp: HwComponent; onPinClick?: (p: string) => void; selectedPin?: string | null }) {
  const { w, h } = comp;
  return (
    <g>
      <rect x={1} y={2} width={w} height={h} rx={7} fill="#12161C" opacity={0.13} filter="url(#softBlur)" />
      <rect x={0} y={0} width={w} height={h} rx={6} fill="#243349" stroke="#121923" strokeWidth={0.8} />
      <rect x={0.7} y={0.7} width={w - 1.4} height={h - 1.4} rx={5.4} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={0.7} />
      <g stroke="#C9A45C" strokeWidth={0.5} opacity={0.3} fill="none">
        <path d={"M14 20 L" + (w - 20) + " 20 L" + (w - 14) + " 26"} />
        <path d={"M18 " + (h - 24) + " L" + (w - 24) + " " + (h - 24)} />
      </g>
      <g fill="#C9A45C" opacity={0.28}>
        <circle cx={10} cy={10} r={1.4} />
        <circle cx={w - 10} cy={10} r={1.4} />
        <circle cx={10} cy={h - 10} r={1.4} />
      </g>
      <text x={w / 2} y={h / 2 - 3} textAnchor="middle" fontSize={7} fontWeight={600} fill="#D2D9E1" letterSpacing={0.6} className="svg-ui">{comp.name}</text>
      <text x={w / 2} y={h / 2 + 7} textAnchor="middle" fontSize={3.8} fill="#8B98A7" letterSpacing={0.4} className="svg-ui">{comp.reference} · 3.3V</text>
      <text x={w / 2} y={h / 2 + 16} textAnchor="middle" fontSize={3.4} fill="#66778A" className="svg-mono">{Object.values(comp.props)[0] ?? ""}</text>
      <PeripheralPins comp={comp} onPinClick={onPinClick} selectedPin={selectedPin} />
    </g>
  );
}

/* ── Schematic representations ─────────────────────────────── */

function SchematicPins({ comp }: { comp: HwComponent }) {
  return (
    <g>
      {comp.pins.map((pin) => {
        const horizontal = pin.dir === "left" || pin.dir === "right";
        const outward = pin.dir === "left" ? 18 : pin.dir === "right" ? -18 : pin.dir === "down" ? "v" : "v";
        const ex = pin.dir === "left" ? pin.x + 18 : pin.dir === "right" ? pin.x - 18 : pin.x;
        const ey = pin.dir === "down" ? pin.y - 18 : pin.dir === "up" ? pin.y + 18 : pin.y;
        return (
          <g key={pin.id}>
            <line x1={pin.x} y1={pin.y} x2={ex} y2={ey} stroke="#767E88" strokeWidth={1} />
            <circle cx={pin.x} cy={pin.y} r={2} fill="#FCFCFD" stroke="#5B636D" strokeWidth={0.8} />
            <text
              x={pin.dir === "left" ? ex + 5 : pin.dir === "right" ? ex - 5 : pin.x}
              y={pin.dir === "down" ? ey + 8 : pin.dir === "up" ? ey - 5 : pin.y + 1.5}
              textAnchor={pin.dir === "left" ? "start" : pin.dir === "right" ? "end" : "middle"}
              fontSize={4}
              fill="#6E7781"
              className="svg-mono"
            >
              {pin.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function SchematicPart({ comp }: { comp: HwComponent }) {
  if (comp.kind === "board") {
    const bodyX = 25;
    const bodyY = 26;
    const bodyW = comp.w - 50;
    const bodyH = comp.h - 44;
    return (
      <g>
        <rect x={bodyX} y={bodyY} width={bodyW} height={bodyH} rx={3} fill="#FCFCFD" stroke="#4C545E" strokeWidth={1.1} />
        <rect x={bodyX} y={bodyY} width={bodyW} height={22} rx={2.5} fill="#F0F3F6" stroke="#DDE2E8" strokeWidth={0.5} />
        <text x={bodyX + 10} y={bodyY + 14} fontSize={6.2} fontWeight={600} fill="#2D333A" letterSpacing={0.4} className="svg-ui">ESP32-S3</text>
        <text x={bodyX + bodyW - 10} y={bodyY + 14} textAnchor="end" fontSize={4.2} fill="#8B939C" className="svg-mono">U1</text>
        <text x={comp.w / 2} y={comp.h / 2 - 2} textAnchor="middle" fontSize={9} fontWeight={550} fill="#3D444C" letterSpacing={0.7} className="svg-ui">ESP32-S3</text>
        <text x={comp.w / 2} y={comp.h / 2 + 9} textAnchor="middle" fontSize={4.2} fill="#8D959E" letterSpacing={0.5} className="svg-ui">DEVKITC-1 · N8R2</text>
        <text x={comp.w / 2} y={comp.h / 2 + 21} textAnchor="middle" fontSize={3.6} fill="#9BA2AA" className="svg-mono">240 MHz · 3.3V</text>
        <g opacity={0.5} stroke="#98A1AA" strokeWidth={0.4}>
          <line x1={bodyX + 10} y1={comp.h / 2 + 32} x2={comp.w - bodyX - 10} y2={comp.h / 2 + 32} strokeDasharray="2 3" />
        </g>
        <SchematicPins comp={comp} />
      </g>
    );
  }
  if (comp.kind === "resistor") {
    return (
      <g>
        <line x1={comp.pins[0].x} y1={12} x2={20} y2={12} stroke="#4B535C" strokeWidth={1} />
        <line x1={58} y1={12} x2={comp.pins[1].x} y2={12} stroke="#4B535C" strokeWidth={1} />
        <path d="M20 12 L24 4 L30 20 L36 4 L42 20 L48 4 L54 20 L58 12" fill="#FCFCFD" stroke="#4B535C" strokeWidth={1} strokeLinejoin="round" />
        <text x={39} y={32} textAnchor="middle" fontSize={4.2} fill="#7C848D" className="svg-mono">R1 220Ω</text>
      </g>
    );
  }
  if (comp.kind === "led") {
    return (
      <g>
        <line x1={0} y1={24} x2={14} y2={24} stroke="#4B535C" strokeWidth={1} />
        <line x1={30} y1={24} x2={44} y2={24} stroke="#4B535C" strokeWidth={1} />
        <path d="M14 14 L14 34 L30 24 Z" fill="#FCFCFD" stroke="#4B535C" strokeWidth={1} strokeLinejoin="round" />
        <line x1={30} y1={14} x2={30} y2={34} stroke="#4B535C" strokeWidth={1.2} />
        <g stroke="#6C8FB3" strokeWidth={0.7} opacity={0.8}>
          <path d="M32 13 L38 8" />
          <path d="M34 17 L41 13" />
        </g>
        <text x={22} y={44} textAnchor="middle" fontSize={4} fill="#7C848D" className="svg-mono">D1</text>
      </g>
    );
  }
  return (
    <g>
      <rect x={16} y={16} width={comp.w - 32} height={comp.h - 32} rx={3} fill="#FCFCFD" stroke="#4C545E" strokeWidth={1} />
      <text x={comp.w / 2} y={comp.h / 2 - 1} textAnchor="middle" fontSize={6} fontWeight={550} fill="#343A41" letterSpacing={0.4} className="svg-ui">{comp.name}</text>
      <text x={comp.w / 2} y={comp.h / 2 + 9} textAnchor="middle" fontSize={4} fill="#8B939C" className="svg-mono">{comp.reference}</text>
      <SchematicPins comp={comp} />
    </g>
  );
}
