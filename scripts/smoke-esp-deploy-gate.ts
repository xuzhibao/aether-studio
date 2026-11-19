import assert from "node:assert/strict";
import {
  bindDeployExpectation, deploymentPlanDigest, enforceSimulationGate, verifyMonitorEvidence, verifySimulationEvidence,
  type EspSimulationEvidence,
} from "../desktop/esp/deployGate";
import type { EspPlannedSegment } from "../shared/esp";

// Pure-function checks for the optional host deploy gate. No device, no stand-in for hardware.
const appSha = "a".repeat(64);
const otherSha = "b".repeat(64);
const segment = (over: Partial<EspPlannedSegment> = {}): EspPlannedSegment => ({
  name: "app", file: "/tmp/firmware.bin", offset: 0x100000, size: 1000, sha256: appSha, chipId: 5, source: "test", ...over,
});
const expected = { port: "COM4", environment: "esp32-c3", appSha256: appSha, inputHash: "c".repeat(64) };
const evidence = (over: Partial<EspSimulationEvidence> = {}): EspSimulationEvidence => ({
  version: 1, passed: true, appSha256: appSha, environment: "esp32-c3", inputHash: "c".repeat(64), recordedAt: "2026-11-19T10:00:00.000Z", source: "qemu:1", ...over,
});

// 1. The strict default accepts only a passed, same-image, same-environment, same-source record.
assert.equal(verifySimulationEvidence(evidence(), expected).allowed, true);
assert.equal(verifySimulationEvidence(null, expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ passed: false }), expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ appSha256: otherSha }), expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ environment: "esp32-s3" }), expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ inputHash: "d".repeat(64) }), expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ version: 2 as unknown as 1 }), expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ recordedAt: "not-a-time" }), expected).allowed, false);
assert.equal(verifySimulationEvidence(evidence({ inputHash: undefined }), expected).allowed, true, "inputHash is optional");

// 2. Binding is to the private snapshot, not to the plan alone.
const snap = { name: "firmware.bin", file: "/tmp/snap/firmware.bin", size: 1000, sha256: appSha };
const bound = bindDeployExpectation({ port: "COM4", environment: "esp32-c3", inputHash: "c".repeat(64), segments: [segment()], snapshots: [snap] });
assert.equal(bound.appSha256, appSha);
assert.throws(() => bindDeployExpectation({ port: "COM4", environment: "esp32-c3", inputHash: "c".repeat(64), segments: [segment()], snapshots: [{ ...snap, sha256: otherSha }] }), /不一致/);
assert.throws(() => bindDeployExpectation({ port: "COM4", environment: "esp32-c3", inputHash: "c".repeat(64), segments: [segment(), segment({ file: "/tmp/firmware2.bin" })], snapshots: [snap] }), /恰好一段/);
assert.throws(() => bindDeployExpectation({ port: "COM4", environment: "esp32-c3", inputHash: "", segments: [segment()], snapshots: [snap] }), /输入指纹/);

// 3. Enforce: disabled means no evidence read at all; enabled reads once and refuses by throwing.
let reads = 0;
const gate = (required: boolean, record: EspSimulationEvidence | null) => ({
  required: () => required,
  evidence: async () => { reads++; return record; },
});
const lines: string[] = [];
assert.equal(await enforceSimulationGate(gate(false, evidence()), async () => expected, (line) => lines.push(line)), null);
assert.equal(reads, 0, "a disabled gate must not read evidence");
assert.equal(await enforceSimulationGate(gate(true, evidence()), async () => expected, (line) => lines.push(line)) !== null, true);
assert.equal(reads, 1);
await assert.rejects(enforceSimulationGate(gate(true, evidence({ appSha256: otherSha })), async () => expected, () => {}), /未写入任何数据/);
await assert.rejects(enforceSimulationGate(gate(true, null), async () => expected, () => {}), /未写入任何数据/);
await assert.rejects(enforceSimulationGate({ required: () => true, evidence: async () => { throw new Error("磁盘不可读"); } }, async () => expected, () => {}), /磁盘不可读.*未写入任何数据/);
assert.equal(lines.length, 1, "only an accepted gate logs");

// 4. Plan digest changes with any planned byte, offset, size, port or environment.
const digest = deploymentPlanDigest("COM4", "esp32-c3", [segment()]);
assert.equal(digest, deploymentPlanDigest("com4", "esp32-c3", [segment()]), "port case is not a different plan");
assert.notEqual(digest, deploymentPlanDigest("COM5", "esp32-c3", [segment()]));
assert.notEqual(digest, deploymentPlanDigest("COM4", "esp32-s3", [segment()]));
assert.notEqual(digest, deploymentPlanDigest("COM4", "esp32-c3", [segment({ sha256: otherSha })]));
assert.notEqual(digest, deploymentPlanDigest("COM4", "esp32-c3", [segment({ offset: 0x200000 })]));

// 5. Monitor binding: new session, same port, observed challenge, after the deploy.
const plan = { port: "COM4", environment: "esp32-c3", appSha256: appSha, planSha256: digest, recordedAt: "2026-11-19T10:00:00.000Z" };
const monitor = { sessionId: "s2", port: "COM4", challenge: "AETHER-1234", startedAt: "2026-11-19T10:01:00.000Z", challengeObserved: true, outputObserved: true };
assert.equal(verifyMonitorEvidence(plan, monitor).ok, true);
assert.equal(verifyMonitorEvidence(plan, monitor, { priorSessionIds: ["s2"] }).ok, false);
assert.equal(verifyMonitorEvidence(plan, { ...monitor, port: "COM5" }).ok, false);
assert.equal(verifyMonitorEvidence(plan, { ...monitor, challengeObserved: false }).ok, false);
assert.equal(verifyMonitorEvidence(plan, { ...monitor, outputObserved: false }).ok, false);
assert.equal(verifyMonitorEvidence(plan, { ...monitor, startedAt: "2026-11-19T09:59:00.000Z" }).ok, false);
assert.equal(verifyMonitorEvidence(plan, { ...monitor, challenge: "" }).ok, false);
assert.equal(verifyMonitorEvidence({ ...plan, planSha256: "" }, monitor).ok, false);
console.log("PASS deploy gate unit checks (pure functions, no device)");

// 6. app-only helpers, anchored to bytes captured read-only from the acceptance board.
{
  const { crc32, parseOtaSelection, parseBootloaderVersion, parseAppDescriptor, parseIdfVersion, idfVersionsCompatible } = await import("../desktop/esp/appOnly");
  assert.equal(crc32(new Uint8Array([1, 0, 0, 0])), 0x4743989a, "CRC matches the value stored in otadata entry 0");
  assert.equal(crc32(new Uint8Array([2, 0, 0, 0])), 0x55f63774, "CRC matches the value stored in otadata entry 1");

  const ota = new Uint8Array(0x2000).fill(0xff);
  const put = (base: number, seq: number, state: number) => {
    const view = new DataView(ota.buffer, base, 32);
    view.setUint32(0, seq, true); view.setUint32(24, state, true); view.setUint32(28, crc32(ota.subarray(base, base + 4)), true);
  };
  put(0, 1, 2); put(0x1000, 2, 2);
  const selection = parseOtaSelection(ota, 2);
  assert.equal(selection.activeIndex, 1);
  assert.equal(selection.activeSeq, 2);
  assert.equal(selection.activeSlot, 1, "seq 2 maps to the second OTA slot: (2-1)%2");
  assert.equal(selection.activeState, 2);

  const sameSeq = new Uint8Array(0x2000).fill(0xff);
  const putSeq = (base: number, seq: number) => {
    const view = new DataView(sameSeq.buffer, base, 32);
    view.setUint32(0, seq, true); view.setUint32(24, 2, true); view.setUint32(28, crc32(sameSeq.subarray(base, base + 4)), true);
  };
  putSeq(0, 2); putSeq(0x1000, 2);
  assert.throws(() => parseOtaSelection(sameSeq, 2), /seq 相同/);
  const oneBad = new Uint8Array(ota); oneBad[0x1000 + 28] ^= 0xff;
  assert.equal(parseOtaSelection(oneBad, 2).activeIndex, 0);
  const bothBad = new Uint8Array(ota); bothBad[28] ^= 0xff; bothBad[0x1000 + 28] ^= 0xff;
  assert.throws(() => parseOtaSelection(bothBad, 2), /都无效/);

  const head = new Uint8Array(0x100);
  head.set(Buffer.from("e903024f10c73c40ee0000000500030300c70000000000012058cd3fd4030000500000000100000076352e3400000000", "hex"));
  const boot = parseBootloaderVersion(head);
  assert.equal(boot?.major, 5); assert.equal(boot?.minor, 4);
  assert.equal(idfVersionsCompatible(boot!, parseIdfVersion("v5.4.2")!), true);
  assert.equal(idfVersionsCompatible(boot!, parseIdfVersion("v4.4.7")!), false);

  const { existsSync, readFileSync } = await import("node:fs");
  // Use a real local build when one exists; a clean checkout has no .pio directory and the
  // parser checks above already cover the capture vectors. Never fabricate a passing image.
  const built = ["examples/platformio-esp32c3/.pio/build/esp32-c3/firmware.bin", "examples/esp32c3-firmware-validation/.pio/build/esp32c3-qemu-uart0/firmware.bin"].find((file) => existsSync(file));
  if (built) {
    const image = new Uint8Array(readFileSync(built));
    const desc = parseAppDescriptor(image);
    assert.equal(desc.magicOk, true, "the real build carries an ESP-IDF app descriptor");
    console.log("real build app descriptor:", built, desc.projectName, desc.version, desc.idfVersion);
  } else {
    console.log("SKIP app descriptor check: no local PlatformIO build in this checkout (no substitute image used)");
  }
  console.log("PASS app-only helper checks (real capture vectors, no device)");
}
