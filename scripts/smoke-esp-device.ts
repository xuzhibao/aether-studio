import assert from "node:assert/strict";
import { SerialPort } from "serialport";
import { inspectEspDevice } from "../desktop/esp/inspect";
import { ToolService } from "../desktop/tools";
import { ESPTOOL_TOOL } from "../desktop/esp/esptool";

// Real hardware check: strictly read-only (`flash_id`, 0x8000 partition read, eFuse summary).
// It resets the chip through esptool's hard reset but never writes flash and never prints the MAC.
// Run with AETHER_ESP_PORT=COM4 npm run smoke:esp:device, or let it pick the only Espressif port.
const ports = await SerialPort.list();
const wanted = process.env.AETHER_ESP_PORT?.trim().toUpperCase();
const espressif = ports.filter((port) => (port.vendorId ?? "").toLowerCase() === "303a");
const port = wanted ? ports.find((item) => item.path.toUpperCase() === wanted)?.path ?? wanted : espressif[0]?.path;
if (!port) {
  console.log("SKIP esp device: no Espressif USB port found (" + ports.map((item) => item.path + " " + (item.vendorId ?? "?") + ":" + (item.productId ?? "?")).join(", ") + ")");
} else {
  const tools = new ToolService(() => process.env.AETHER_TOOL_SETTINGS ?? "esp-device-tools.json");
  tools.define(ESPTOOL_TOOL);
  const result = await inspectEspDevice(port, tools);
  const printable = JSON.stringify(result);
  assert.equal(result.readOnly, true);
  assert.ok(!/MAC:\s*[0-9a-f]{2}:/i.test(printable), "the MAC value must never be returned");
  assert.ok(!/[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/i.test(printable), "no hardware address may leak into the result");
  if (result.error) {
    console.log("FAIL esp device " + port + ": " + result.error);
    process.exitCode = 1;
  } else {
    assert.equal(result.board.model, "unknown");
    assert.ok(result.chip, "a chip must be identified");
    console.log("PASS esp device " + port + " (read-only): " +
      [result.chip?.name, result.chip?.variant, "rev " + result.chip?.revision, "flash " + (result.flash?.size ? result.flash.size / 1048576 + "MB" : "?") + " (" + result.flash?.manufacturer + "/" + result.flash?.device + ")",
        result.usbClass.vendor + " " + result.usbClass.note,
        "partitions " + (result.partitions.valid ? result.partitions.entries.map((entry) => entry.label + "@0x" + entry.offset.toString(16) + "/0x" + entry.size.toString(16)).join(",") : "invalid: " + result.partitions.error),
        "security " + (result.security ? "secureBoot=" + result.security.secureBoot + " flashEnc=" + result.security.flashEncryption + " downloadDisabled=" + result.security.downloadModeDisabled : "unread"),
        "tool " + result.tool.version + " (" + result.tool.source + ")", result.durationMs + "ms"].filter(Boolean).join(" · "));
    if (result.notes.length) console.log("notes: " + result.notes.join(" | "));
  }
}
