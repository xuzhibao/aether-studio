import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PluginRegistry } from "../src/plugins/registry";
import type { StudioPlugin } from "../src/plugins/api";

const data = new Map<string, string>();
const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
Object.defineProperty(globalThis, "localStorage", { value: storage });
Object.defineProperty(globalThis, "window", { value: globalThis });
const registry = new PluginRegistry(storage);
let samples = 0;
let deactivations = 0;
const fixture: StudioPlugin = {
  manifest: { id: "smoke.fixture", name: "Lifecycle fixture", version: "0.1.0", type: "workspace", entry: "smoke", enabled: true, description: "Test fixture" },
  activate(api) {
    api.register("commands", { id: "test", name: "Test event", run: () => api.events.emit("test") });
    api.events.on("test", () => samples++);
  },
  deactivate() { deactivations++; },
};
registry.register(fixture);
assert.throws(() => registry.register(fixture), /Duplicate/);
registry.start();
registry.require("commands", "test").run();
assert.equal(samples, 1);
registry.disable("smoke.fixture");
registry.emit("test");
assert.equal(samples, 1, "disabled plugin event subscriptions are removed");
assert.equal(registry.all("commands").length, 0);
registry.enable("smoke.fixture");
registry.require("commands", "test").run();
assert.equal(samples, 2, "re-enable registers exactly one listener");
registry.unregister("smoke.fixture");
assert.equal(registry.list().length, 0);
assert.equal(deactivations, 2);
const cycle = new PluginRegistry();
for (const [id, dep] of [["a", "b"], ["b", "a"]]) cycle.register({ ...fixture, manifest: { ...fixture.manifest, id, dependencies: [dep] } });
assert.throws(() => cycle.enable("a"), /cycle/);
assert.equal(cycle.all("commands").length, 0);
console.log("PASS registry: lifecycle, cleanup, duplicate IDs, dependency cycle, unregister");

const { useStudio } = await import("../src/store/studio");
const { plugins } = await import("../src/plugins/runtime");
const state = () => useStudio.getState();
assert.equal(plugins.list().length, 10);
assert.equal(plugins.list().filter((p) => p.enabled).length, 10);
assert.throws(() => plugins.disable("aether.esp32-s3"), /请先停用/);
state().createProject({ name: "Smoke hardware project", board: "esp32-s3", template: "Blank workspace" });
const projectId = state().activeProjectId;
assert.equal(state().components.length, 1);
state().runSimulation();
assert.equal(state().runState, "idle", "missing parts must not fake a successful run");
state().addComponent("bme280");
state().addComponent("oled");
const bme = state().components.find((c) => c.kind === "bme280")!;
state().moveComponent(bme.id, 120, 420);
state().startWire("board-1", "l11");
state().completeWire(bme.id, "sda");
const code = state().files["main.py"] + "\n# smoke: edited\n";
state().updateFile("main.py", code);
state().build();
assert.ok(state().console.some((l) => l.text.includes("未执行 Python")));
state().runSimulation();
state().tick();
state().tick();
assert.equal(state().runState, "running");
assert.ok(state().serial.some((l) => l.text.includes("[Demo Simulation] T=")));
assert.ok(!state().serial.some((l) => l.text.includes("MQTT")));
state().saveProject();
const persisted = JSON.parse(storage.getItem("aether.projects.v1")!);
assert.equal(persisted.workspaces[projectId].files["main.py"], code);
assert.equal(persisted.workspaces[projectId].components.find((c: {id: string}) => c.id === bme.id).x, 120);
assert.equal(persisted.workspaces[projectId].wires.length, 1);
assert.deepEqual(persisted.workspaces[projectId].capabilities, state().capabilities);
state().createProject({ name: "Second project", board: "esp32-s3", template: "Environment monitor" });
state().switchProject(projectId);
assert.equal(state().files["main.py"], code);
assert.equal(state().wires.length, 1);
assert.equal(state().runState, "idle");
plugins.disable("aether.demo");
assert.equal(plugins.all("panels").length, 0);
assert.equal(plugins.get("menus", "demo.menu"), undefined);
assert.equal(plugins.get("commands", "demo.run"), undefined);
state().runSimulation();
assert.equal(state().runState, "idle");
plugins.enable("aether.demo");
assert.equal(plugins.all("panels").length, 1);
state().setSidebarWidth(280);
state().setAgentWidth(400);
state().setSplitMode(true);
state().setSplitRatio(64);
state().updateSettings({ fontSize: 15, reducedMotion: true });
state().saveLayout();
const reopened = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
  import assert from "node:assert/strict";
  const data = new Map(JSON.parse(process.env.AETHER_SMOKE_STORAGE));
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } });
  Object.defineProperty(globalThis, "window", { value: globalThis });
  const { useStudio } = await import("./src/store/studio.ts");
  const state = useStudio.getState();
  assert.equal(state.projects.find((p) => p.id === state.activeProjectId).name, "Smoke hardware project");
  assert.ok(state.files["main.py"].includes("# smoke: edited"));
  assert.equal(state.components.find((p) => p.kind === "bme280").x, 120);
  assert.equal(state.wires.length, 1);
  assert.equal(state.runState, "idle");
  assert.equal(state.sidebarWidth, 280);
  assert.equal(state.agentWidth, 400);
  assert.equal(state.splitRatio, 64);
  assert.equal(state.settings.fontSize, 15);
  assert.equal(state.settings.reducedMotion, true);
`], { encoding: "utf8", env: { ...process.env, AETHER_SMOKE_STORAGE: JSON.stringify([...data]) } });
assert.equal(reopened.status, 0, reopened.stderr || reopened.stdout);
console.log("PASS project: create, edit circuit/code, file check, demo output, persistence, fresh-process reopen, disabled capabilities");

const format = plugins.require("projectFormats", "aether");
const exported = format.encode(state().getProjectContext());
const restoredProject = format.decode(exported);
assert.equal(restoredProject.files["main.py"], code);
assert.equal(restoredProject.components.find((c) => c.kind === "bme280")!.x, 120);
assert.equal(restoredProject.wires.length, 1);
const malformed = JSON.parse(exported);
malformed.workspace.wires[0].to.pin = "missing";
assert.throws(() => format.decode(JSON.stringify(malformed)), /连线/);
malformed.workspace = { ...JSON.parse(exported).workspace, files: { "../bad.py": "x" } };
assert.throws(() => format.decode(JSON.stringify(malformed)), /文件名/);
assert.throws(() => format.decode(JSON.stringify({ ...JSON.parse(exported), version: 999 })), /版本/);
const beforeImport = state().activeProjectId;
const originalSetItem = storage.setItem;
storage.setItem = () => { throw new Error("Storage full"); };
assert.throws(() => state().importProject(restoredProject), /Storage full/);
assert.equal(state().activeProjectId, beforeImport, "failed import must preserve the active workspace");
storage.setItem = originalSetItem;
state().importProject(restoredProject);
assert.notEqual(state().activeProjectId, beforeImport);
assert.equal(state().workspaces[beforeImport].files["main.py"], code);
assert.equal(state().files["main.py"], code);
assert.equal(state().wires.length, 1);
plugins.disable("aether.project-files");
assert.equal(plugins.get("commands", "project.export"), undefined);
plugins.enable("aether.project-files");
console.log("PASS project files/layout: portable round trip, malformed input, non-destructive import failure, plugin disable, fresh-process preferences");

await state().runAgent("Explain project");
assert.ok(state().agentMessages.at(-1)!.text.includes("请求未完成"));
assert.equal(state().files["main.py"], code, "unconfigured AI must not modify files");
plugins.setSetting("aether.ai.openai", "endpoint", "https://example.test/v1/chat/completions");
plugins.setSetting("aether.ai.openai", "model", "test-model");
plugins.setSetting("aether.ai.openai", "apiKey", "smoke-only-key", false);
assert.ok(!storage.getItem("aether.plugins.settings")!.includes("smoke-only-key"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://example.test/v1/chat/completions");
  assert.equal(JSON.parse(String(init?.body)).model, "test-model");
  assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer smoke-only-key");
  assert.ok(String(init?.body).includes("Smoke hardware project"));
  return new Response(JSON.stringify({ choices: [{ message: { content: "API fixture response (test only)" } }] }), { status: 200 });
};
await state().runAgent("Explain project");
assert.equal(state().agentMessages.at(-1)!.text, "API fixture response (test only)");
globalThis.fetch = async () => new Response("unavailable", { status: 503 });
await state().runAgent("Explain project");
assert.ok(state().agentMessages.at(-1)!.text.includes("HTTP 503"));
globalThis.fetch = originalFetch;
assert.equal(state().files["main.py"], code);
console.log("PASS AI adapter: configuration error, HTTP request/response contract, HTTP failure, ephemeral key (mock HTTP only)");

state().setAgent("api-tools");
let toolTurn = 0;
const updatedCode = code + "\n# suggested by tool fixture\n";
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body));
  assert.ok(body.tools.some((t: { function: { name: string } }) => t.function.name === "project_read_file"));
  const reply = toolTurn++ === 0
    ? { content: null, tool_calls: [{ id: "read", type: "function", function: { name: "project_read_file", arguments: JSON.stringify({ path: "main.py" }) } }, { id: "circuit", type: "function", function: { name: "project_inspect_circuit", arguments: "{}" } }] }
    : toolTurn === 2
      ? { content: null, tool_calls: [{ id: "propose", type: "function", function: { name: "project_propose_files", arguments: JSON.stringify({ summary: "Test proposal (fixture only)", files: [{ path: "main.py", content: updatedCode }] }) } }] }
      : { content: "Test fixture: modification is pending review." };
  if (toolTurn === 2) {
    assert.ok(body.messages.some((m: {role: string; tool_call_id: string; content: string}) => m.role === "tool" && m.tool_call_id === "read" && JSON.parse(m.content).content === code));
  }
  return new Response(JSON.stringify({ choices: [{ message: reply }] }));
};
await state().runAgent("Propose a code change");
const message = state().agentMessages.at(-1)!;
assert.equal(message.toolRuns!.length, 3);
assert.ok(message.toolRuns!.every((run) => run.status === "done"));
assert.equal(message.proposals!.length, 1);
assert.equal(state().files["main.py"], code, "tool proposals must not write files");
const proposal = message.proposals![0];
state().updateFile("main.py", code + "# manual edit");
state().resolveProposal(message.id, proposal.id, true);
assert.equal(state().files["main.py"], code + "# manual edit", "stale proposal cannot overwrite manual edits");
state().updateFile("main.py", code);
state().resolveProposal(message.id, proposal.id, false);
assert.equal(state().files["main.py"], code);
toolTurn = 0;
await state().runAgent("Propose again");
const accepted = state().agentMessages.at(-1)!;
state().resolveProposal(accepted.id, accepted.proposals![0].id, true);
assert.equal(state().files["main.py"], updatedCode);
assert.equal(state().dirty, true);
const proposalTool = plugins.require("tools", "project_propose_files");
assert.throws(() => proposalTool.execute({ summary: "invalid", files: [{ path: "../bad.py", content: "x" }] }, state().getProjectContext()), /路径/);
assert.throws(() => proposalTool.execute({ summary: "invalid", files: [{ path: "circuit.json", content: "{}" }] }, state().getProjectContext()), /circuit.json/);
let started!: () => void;
const requestStarted = new Promise<void>((resolve) => { started = resolve; });
globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
  started();
  init!.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
});
const pending = state().runAgent("Wait for API");
await requestStarted;
state().cancelAgent();
await pending;
assert.equal(state().agentRunning, false);
assert.match(state().agentMessages.at(-1)!.text, /已取消/);
assert.equal(state().files["main.py"], updatedCode);
plugins.disable("aether.project-tools");
assert.equal(plugins.all("tools").length, 0);
plugins.enable("aether.project-tools");
globalThis.fetch = originalFetch;
console.log("PASS Agent tools: real tool-result protocol, read/inspect, pending proposal, conflict refusal, reject/apply, path validation, cancellation and plugin disable (HTTP fixtures only)");

// Explicit backend fixture verifies frontend lifecycle; real OS PTY I/O runs in desktop CI.
const { createNativeSerialPlugin, nativeSerialPlugin } = await import("../src/plugins/builtin/nativeSerial");
const { useTransport } = await import("../src/store/transport");
const io = () => useTransport.getState();
const received: number[][] = [];
const written: number[][] = [];
const closed: number[] = [];
let nextSession = 0;
let readFailure = false;
let openGate: Promise<void> | undefined;
const serialFixture = createNativeSerialPlugin({
  list: async () => [{ path: "fixture-port", label: "Backend fixture (not hardware)" }],
  open: async () => { await openGate; return ++nextSession; },
  read: async () => { if (readFailure) throw new Error("fixture unplugged"); return received.shift() ?? []; },
  write: async (_id, bytes) => { written.push(bytes); }, close: async (id) => { closed.push(id); },
}, true);
const until = async (condition: () => boolean) => { for (let n = 0; n < 100 && !condition(); n++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(condition()); };
plugins.unregister("aether.serial.native");
plugins.register(serialFixture); plugins.enable("aether.serial.native");
assert.equal(plugins.require("transports", "native-serial").id, "native-serial");
assert.equal((await plugins.require("transports", "native-serial").list())[0].path, "fixture-port");
await io().connect("native-serial", { path: "fixture-port", baudRate: 115200 });
assert.equal(io().status, "connected");
const bytes = Array.from(new TextEncoder().encode("温度:24.6\n"));
received.push(bytes.slice(0, 1), bytes.slice(1));
await until(() => io().receivedBytes === bytes.length);
assert.ok(io().lines.some((line) => line.text.includes("温度:24.6")), "UTF-8 decoding survives byte boundaries");
await io().send("status\r\n");
assert.equal(new TextDecoder().decode(Uint8Array.from(written[0])), "status\r\n");
assert.equal(io().sentBytes, 8);
plugins.disable("aether.serial.native");
await until(() => io().status === "disconnected" && closed.includes(1));
await assert.rejects(() => io().send("not sent"), /请先连接/);
assert.equal(written.length, 1);
plugins.enable("aether.serial.native");
let releaseOpen!: () => void;
openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
const pendingConnect = io().connect("native-serial", { path: "fixture-port", baudRate: 115200 });
assert.equal(io().status, "connecting");
plugins.disable("aether.serial.native");
releaseOpen(); await pendingConnect;
await until(() => closed.includes(2));
assert.equal(io().status, "disconnected", "a late open after disable must not resurrect the connection");
openGate = undefined;
plugins.enable("aether.serial.native");
await io().connect("native-serial", { path: "fixture-port", baudRate: 115200 });
readFailure = true;
await until(() => io().status === "error");
assert.match(io().error, /unplugged/);
assert.ok(closed.includes(3));
readFailure = false;
plugins.unregister("aether.serial.native");
plugins.register(nativeSerialPlugin); plugins.enable("aether.serial.native");
console.log("PASS transport: capability registration, split UTF-8 bytes, actual write contract, disable cleanup, late open cancellation and read error (backend fixtures; OS PTY tested separately)");
