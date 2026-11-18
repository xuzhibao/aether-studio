import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import { openAICompatibleProvider } from "../src/plugins/builtin/provider";
import type { PluginAPI } from "../src/plugins/api";

// A local OpenAI-compatible fixture server: no online model, no credential from the user.
type Mode = "success" | "unauthorized" | "invalid-json" | "no-message" | "slow";
let mode: Mode = "success";
const requests: { path: string; auth: string; body: Record<string, unknown> }[] = [];
const server = createServer(async (request, response) => {
  request.on("error", () => {});
  response.on("error", () => {});
  let text = "";
  for await (const chunk of request) text += chunk;
  requests.push({ path: request.url ?? "", auth: String(request.headers.authorization ?? ""), body: JSON.parse(text || "{}") });
  if (mode === "unauthorized") { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "invalid key" } })); return; }
  if (mode === "invalid-json") { response.writeHead(200, { "content-type": "application/json" }); response.end("not json"); return; }
  if (mode === "no-message") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [] })); return; }
  if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ model: "fixture/model-1", choices: [{ message: { content: "pong" } }] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const endpoint = "http://127.0.0.1:" + port + "/v1/chat/completions";

const key = "fixture-session-key";
const providerWith = (values: Record<string, string>) => {
  const writes: [string, string][] = [];
  const api = {
    settings: { get: (name: string) => values[name] ?? "", set: (name: string, value: string) => { writes.push([name, value]); } },
  } as unknown as PluginAPI;
  return { provider: openAICompatibleProvider(api), writes };
};

let passed = 0;
const check = (name: string) => { passed++; console.log("  ✓ " + name); };

try {
  // --- The success state only exists after a real, parsed response; the request uses the form values.
  mode = "success";
  const { provider, writes } = providerWith({ endpoint, model: "form-model", apiKey: key });
  const result = await provider.test!();
  assert.equal(result.model, "fixture/model-1", "the response model is displayed");
  assert.ok(result.latencyMs >= 0);
  assert.match(result.detail, /有效回复/);
  const request = requests.at(-1)!;
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.auth, "Bearer " + key, "the current form key is used");
  assert.equal(request.body.model, "form-model", "the current form model is used");
  assert.deepEqual(request.body.messages, [{ role: "user", content: "ping" }], "the probe carries no project content");
  assert.equal(request.body.stream, false);
  assert.equal(request.body.max_tokens, 8);
  assert.equal(Object.hasOwn(request.body, "tools"), false, "the probe does not advertise project tools");
  assert.equal(writes.length, 0, "testing never writes settings or the key");
  check("success test uses the form adapter, minimal body, and reports the response model");

  // --- A 401 is a failure, and the key never appears in the error text.
  mode = "unauthorized";
  const failure = await provider.test!().then(() => null, (error: unknown) => error as Error);
  assert.ok(failure, "a 401 must reject");
  assert.match(failure!.message, /HTTP 401/);
  assert.doesNotMatch(failure!.message, new RegExp(key));
  check("HTTP errors are reported without echoing the API key");

  // --- Malformed success responses are not accepted as success.
  mode = "invalid-json";
  await assert.rejects(() => provider.test!(), /有效 JSON/);
  mode = "no-message";
  await assert.rejects(() => provider.test!(), /缺少 message\.content/);
  check("invalid JSON and missing messages fail instead of showing a preset success");

  // --- Cancellation aborts the real request and is distinguishable from success or failure.
  mode = "slow";
  const run = new AbortController();
  const cancelled = provider.test!(run.signal);
  setTimeout(() => run.abort(), 50);
  const abort = await cancelled.then(() => null, (error: unknown) => error as Error);
  assert.ok(abort, "an aborted test must reject");
  assert.equal((abort as Error).name, "AbortError");
  check("test is cancellable through the provider adapter");

  // --- A missing model fails before any network request.
  const before = requests.length;
  await assert.rejects(() => providerWith({ endpoint, model: "", apiKey: key }).provider.test!(), /模型名称/);
  assert.equal(requests.length, before, "no request was sent without a model");
  check("missing model is refused before the request");

  // --- Remote plain HTTP stays refused; only loopback may use http.
  await assert.rejects(() => providerWith({ endpoint: "http://agent-fixture.example/v1/chat/completions", model: "m", apiKey: key }).provider.test!(), /HTTPS/);
  check("remote HTTP endpoints are refused");

  // --- Network errors also do not leak the key.
  const dead = "http://127.0.0.1:9/v1/chat/completions";
  const network = await providerWith({ endpoint: dead, model: "m", apiKey: key }).provider.test!().then(() => null, (error: unknown) => error as Error);
  assert.ok(network);
  assert.doesNotMatch(network!.message, new RegExp(key));
  check("network failures are reported without the key");

  // --- The existing chat/complete path shares the same request construction.
  mode = "success";
  assert.equal(await provider.complete([{ role: "user", content: "hello" }]), "pong");
  assert.equal(requests.at(-1)!.body.model, "form-model");
  check("chat still works through the shared request path");

  console.log("PASS provider: " + passed + " checks; connection test uses the real adapter, a local fixture server, cancellation, and never persists the key");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
