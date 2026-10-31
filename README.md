# Aether Studio

Aether Studio is a macOS-first, AI-native hardware development environment. It brings a virtual bench, firmware editor, live simulation and an autonomous engineering agent into one desktop workspace.

The current build is a complete, high-fidelity frontend with realistic mock simulation and agent behavior. The simulation engine, LLM backend and hardware transport are isolated behind store actions so they can be replaced with real services.

## Run

```bash
npm install
npm run dev          # browser preview at http://localhost:1420
npm run tauri dev    # native Tauri 2 desktop window
```

Requires Node 20+ and, for the native shell, the Rust toolchain and Tauri prerequisites.

## Stack

- Tauri 2 desktop shell with custom traffic lights and drag region
- React 18 + TypeScript + Vite
- Tailwind CSS with a custom macOS design system
- Radix UI primitives (menus, popovers, dialogs, tooltips)
- Zustand workspace, simulation and agent state
- Monaco Editor with a custom light theme and inline agent annotations
- Custom SVG hardware canvas with drag, pan, zoom, wiring and an inspector
- Motion for panel and message transitions
- Lucide icons

## Workspace

The default project, **Smart Environment Monitor**, is a working virtual bench:

- ESP32-S3 DevKitC-1, BME280, SSD1306 OLED, LED and 220 Ω resistor
- I²C wiring on GPIO 8 / GPIO 9 with live OLED readings
- MicroPython firmware and a serial console
- Simulated sampling, warnings, MQTT uplink and deployment
- Aether Agent that can build, patch and verify the project

## Interaction

- `⌘K` command palette
- `⌘S` save, `⌘B` build, `⌘R` run, `⌘J` agent, `⌘\` sidebar
- Canvas tools: `V` select, `W` wire, `A` add, `I` inspect
- `⌘` + scroll to zoom; scroll to pan; Space-drag to pan
- Click a component to open the property/pin inspector
- Drag the sidebar, agent panel, debug dock and split divider

## Integration points

- `src/store/studio.ts` — single source of truth for workspace, circuit, simulation and agent runs
- `src/data/mock.ts` — replace with API/project persistence
- `addComponent`, `completeWire` and `moveComponent` — hook to a circuit graph/ERC engine
- `tick` and `build` — hook to a real simulator/build service
- `runAgent` — replace the scripted steps with streamed agent events
- `src/lib/desktop.ts` — native window controls; add deployment/USB bridges here

The UI is light-mode first. Colors, surfaces and borders are tokenised in `src/index.css` for a future dark theme.
