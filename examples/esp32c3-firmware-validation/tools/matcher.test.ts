// Pure-matcher tests: split chunks, stale tokens, wrong values, timeouts and
// disconnects. These exercise the shared module only — no serial port, no QEMU.
import assert from "node:assert/strict";
import test from "node:test";

import { FwValSession, fwvalAnswer } from "../../../shared/firmwareValidation";

const FWID = "aether-c3-fwval-1";
const TOKEN = "0123456789abcdef";
const READY = `AETHER-VAL/1 READY fw=${FWID} proto=1 soc=esp32c3 console=uart0\r\n`;

function makeSession(options: { transport?: "qemu-uart0" | "uart0" | "usb-serial-jtag"; expectedFwid?: string } = {}) {
  let now = 1_000;
  const session = new FwValSession({
    runId: "test-run",
    transport: options.transport ?? "qemu-uart0",
    expectedFwid: options.expectedFwid,
    now: () => now,
  });
  return {
    session,
    advance(ms: number) {
      now += ms;
    },
    feed(text: string) {
      return session.feed(new Uint8Array(Buffer.from(text, "utf8")));
    },
  };
}

test("passes a full round-trip split across chunk boundaries", () => {
  const { session, feed } = makeSession();
  const bootLog = "ESP-ROM:esp32c3-api1-20210207\r\nI (36) boot: Partition Table:\r\n";
  feed(bootLog + READY);
  assert.equal(session.currentPhase, "ready");
  session.issueChallenge(TOKEN);
  const response = `AETHER-VAL/1 RESPONSE token=${TOKEN} value=${fwvalAnswer(TOKEN, FWID)} fw=${FWID}\r\n`;
  for (const byte of Buffer.from(response, "utf8")) {
    feed(String.fromCharCode(byte));
  }
  assert.equal(session.passed, true);
  const record = session.finish();
  assert.equal(record.verdict, "pass");
  assert.equal(record.evidence, "virtual");
  assert.equal(record.device?.fwid, FWID);
  assert.equal(record.ignoredLines, 2);
  assert.ok(record.bytesIn > 0);
});

test("rejects a response that echoes an older token", () => {
  const { session, feed } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  feed(`AETHER-VAL/1 RESPONSE token=ffffffffffffffff value=00000000 fw=${FWID}\r\n`);
  const record = session.finish();
  assert.equal(record.verdict, "fail");
  assert.equal(record.failure?.code, "stale-token");
});

test("rejects a wrong application answer", () => {
  const { session, feed } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  const wrong = fwvalAnswer(TOKEN, FWID) === "00000000" ? "00000001" : "00000000";
  feed(`AETHER-VAL/1 RESPONSE token=${TOKEN} value=${wrong} fw=${FWID}\r\n`);
  const record = session.finish();
  assert.equal(record.verdict, "fail");
  assert.equal(record.failure?.code, "value-mismatch");
});

test("times out without a matching response", () => {
  const { session, feed, advance } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  advance(6_000);
  session.tick();
  const record = session.finish();
  assert.equal(record.verdict, "fail");
  assert.equal(record.failure?.code, "response-timeout");
});

test("times out when the device never reports READY", () => {
  const { session, advance } = makeSession();
  advance(16_000);
  session.tick();
  const record = session.finish();
  assert.equal(record.failure?.code, "ready-timeout");
});

test("a disconnect before the verdict is never a pass", () => {
  const { session, feed } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  session.disconnect("qemu exited with code 1");
  const record = session.finish();
  assert.equal(record.verdict, "fail");
  assert.equal(record.failure?.code, "disconnected");
});

test("an identical READY before the challenge is a repeated identity, not a reboot", () => {
  const { session, feed } = makeSession();
  feed(READY);
  feed(READY);
  assert.equal(session.currentPhase, "ready");
  session.issueChallenge(TOKEN);
  feed(`AETHER-VAL/1 RESPONSE token=${TOKEN} value=${fwvalAnswer(TOKEN, FWID)} fw=${FWID}\r\n`);
  assert.equal(session.finish().verdict, "pass");
});

test("a READY with a different identity during the challenge means the device rebooted", () => {
  const { session, feed } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  feed(READY.replace(FWID, "another-image"));
  const record = session.finish();
  assert.equal(record.failure?.code, "reboot-detected");
});

test("an identical READY that crosses the challenge does not fail the run", () => {
  const { session, feed } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  feed(READY);
  feed(`AETHER-VAL/1 RESPONSE token=${TOKEN} value=${fwvalAnswer(TOKEN, FWID)} fw=${FWID}
`);
  assert.equal(session.finish().verdict, "pass");
});

test("a response before READY cannot pass", () => {
  const { session, feed } = makeSession();
  feed(`AETHER-VAL/1 RESPONSE token=${TOKEN} value=00000000 fw=${FWID}\r\n`);
  assert.equal(session.finish().failure?.code, "response-before-ready");
});

test("an overlong serial line fails the run", () => {
  const { session, feed } = makeSession();
  feed("x".repeat(600) + "\n");
  assert.equal(session.finish().failure?.code, "line-too-long");
});

test("an identity pin mismatch fails even with a valid answer", () => {
  const { session, feed } = makeSession({ expectedFwid: "other-image" });
  feed(READY);
  assert.equal(session.finish().failure?.code, "fwid-mismatch");
});

test("a device ERROR line is a failure, not a pass", () => {
  const { session, feed } = makeSession();
  feed(READY);
  session.issueChallenge(TOKEN);
  feed("AETHER-VAL/1 ERROR code=bad-token\r\n");
  const record = session.finish();
  assert.equal(record.verdict, "fail");
  assert.equal(record.failure?.code, "device-error");
});

test("hardware transports are tagged as hardware evidence", () => {
  const { session, feed } = makeSession({ transport: "usb-serial-jtag" });
  feed(READY.replace("console=uart0", "console=usb-serial-jtag"));
  assert.equal(session.finish().evidence, "hardware");
});
