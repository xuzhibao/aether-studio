import assert from "node:assert/strict";
import { FwValStabilityMonitor } from "../shared/firmwareValidation";
import { firmwareDevStageOrder, normalizeFirmwareDevPort } from "../desktop/firmwareDev";
import { isEditableFirmwareSource } from "../shared/firmwareDev";
import { deviceIdentityFrom } from "../desktop/esp/inspect";

// Path checks for the automatic firmware task that do not need a board.
//
// They exercise the pure decision points the host relies on: how a COUNT reply is accepted, how a
// reboot/watchdog marker inside an already-open session is detected, how a counter regression is
// refused, and which files an authorized edit may touch. No serial port, no emulator and no fake
// CLI is started here, so nothing in this file can be presented as hardware evidence.

let passed = 0;
const check = (name: string) => { passed += 1; console.log("  ✓ " + name); };
const feed = (monitor: FwValStabilityMonitor, text: string) => monitor.feed(Buffer.from(text, "utf8"));

// --- Twenty strictly increasing COUNT replies are accepted in order.
{
  const monitor = new FwValStabilityMonitor({ runId: "test", expectedCounts: 20 });
  for (let value = 1; value <= 20; value++) {
    monitor.request();
    feed(monitor, "AETHER-VAL/1 COUNT value=" + value + "\r\n");
  }
  const result = monitor.finish();
  assert.equal(result.counts.length, 20, "all twenty replies are recorded");
  assert.equal(result.strictlyIncreasing, true);
  assert.equal(result.restartDetected, false);
  assert.equal(result.failure, "");
  check("20 increasing COUNT replies are accepted");
}

// --- A reply can arrive split across chunks; only complete lines count.
{
  const monitor = new FwValStabilityMonitor({ runId: "test", expectedCounts: 2 });
  monitor.request();
  feed(monitor, "AETHER-VAL/1 COUNT val");
  feed(monitor, "ue=1\nAETHER-VAL/1 COUNT value=2");
  assert.deepEqual(monitor.finish().counts, [1], "an unfinished line is not a reply");
  feed(monitor, "\n");
  assert.deepEqual(monitor.finish().counts, [1, 2]);
  check("partial lines are buffered, never counted early");
}

// --- A counter that went backwards plus a ROM banner is a reboot, not a pass.
{
  const monitor = new FwValStabilityMonitor({ runId: "test", expectedCounts: 3 });
  monitor.request(); feed(monitor, "AETHER-VAL/1 COUNT value=1\n");
  monitor.request(); feed(monitor, "AETHER-VAL/1 COUNT value=2\n");
  feed(monitor, "E (5147) task_wdt: Task watchdog got triggered\n");
  feed(monitor, "ESP-ROM:esp32c3-2022\n");
  monitor.request(); feed(monitor, "AETHER-VAL/1 COUNT value=1\n");
  const result = monitor.finish();
  assert.equal(result.strictlyIncreasing, false, "a regression is not increasing");
  assert.equal(result.restartDetected, true);
  assert.ok(result.restartMarkers.includes("task_wdt"));
  assert.ok(result.restartMarkers.includes("bootrom-banner"));
  check("watchdog and ROM banner inside the open session are detected");
}

// --- Ordinary IDF log lines are data, not a reboot.
{
  const monitor = new FwValStabilityMonitor({ runId: "test", expectedCounts: 1 });
  feed(monitor, "I (812) fwval: USB-Serial/JTAG channel started\n");
  feed(monitor, "W (901) fwval: something harmless\n");
  monitor.request(); feed(monitor, "AETHER-VAL/1 COUNT value=1\n");
  const result = monitor.finish();
  assert.equal(result.restartDetected, false, "log lines must not look like a reset");
  assert.equal(result.strictlyIncreasing, true);
  check("ordinary log lines do not look like a restart");
}

// --- A missing reply fails closed on the deadline.
{
  let clock = 1000;
  const monitor = new FwValStabilityMonitor({ runId: "test", expectedCounts: 1, now: () => clock });
  monitor.request();
  clock += 5001;
  monitor.tick(5000);
  const result = monitor.finish();
  assert.equal(result.failure, "count-timeout");
  assert.equal(result.strictlyIncreasing, false);
  check("a COUNT that never arrives is a failure");
}

// --- An identity that repeats verbatim (HELLO) is not a new boot; a changed one is.
{
  const monitor = new FwValStabilityMonitor({ runId: "test", expectedCounts: 1 });
  const ready = "AETHER-VAL/1 READY fw=aether-c3-fwval-1 proto=1 soc=esp32c3 console=usb-serial-jtag\n";
  feed(monitor, ready); feed(monitor, ready);
  assert.deepEqual(monitor.finish().readyIdentities, [ready.trimEnd()], "identical READY is de-duplicated");
  feed(monitor, "AETHER-VAL/1 READY fw=other proto=1 soc=esp32c3 console=usb-serial-jtag\n");
  assert.equal(monitor.finish().readyIdentities.length, 2);
  check("READY identities are recorded, not trusted as a boot");
}

// --- Edit scope: only existing firmware sources, never generated or out-of-scope paths.
{
  for (const allowed of ["src/main.c", "src/fwval_core.h", "src/net/http.cpp"]) assert.equal(isEditableFirmwareSource(allowed), true, allowed);
  for (const refused of ["platformio.ini", "partitions.vendor.csv", "sdkconfig.defaults", "CMakeLists.txt",
    "src/../main.c", "/abs/src/main.c", "src/", "src/.hidden.c", "hardware/circuit.json", "aether.project.json",
    "src/main.py", "data/blob.bin"]) assert.equal(isEditableFirmwareSource(refused), false, refused);
  check("edit scope accepts only in-tree firmware sources");
}

// --- Stage order is the documented one, and ports normalize like the lease does.
{
  assert.deepEqual(firmwareDevStageOrder, ["ready", "built", "simulated", "previewed", "written", "verified"]);
  assert.equal(normalizeFirmwareDevPort(" com4 "), "COM4");
  check("stage order and port normalization are fixed");
}

// --- The board handle is opaque, stable per chip and different for another board.
{
  const a = "MAC: 34:cd:b0:97:63:f0" + String.fromCharCode(10);
  const b = "MAC: 34:cd:b0:97:63:f1" + String.fromCharCode(10);
  const first = deviceIdentityFrom(a);
  assert.equal(first, deviceIdentityFrom(a), "the same chip always yields the same handle");
  assert.equal(/^[0-9a-f]{16}$/.test(first), true, "the handle is an opaque 16-hex token");
  assert.equal(first.includes("34cdb0"), false, "the raw MAC never leaks into the handle");
  assert.notEqual(first, deviceIdentityFrom(b), "another chip yields another handle");
  assert.equal(deviceIdentityFrom("no mac here"), "", "a chip that reported no MAC has no handle");
  check("device identity is opaque, stable per chip and absent when unknown");
}

console.log("PASS firmware-dev-path: " + passed + " checks");
