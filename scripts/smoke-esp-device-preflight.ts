import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerialPort } from "serialport";
import { samePartitionTable } from "../shared/esp";
import { WorkspaceService } from "../desktop/workspace";
import { ToolService } from "../desktop/tools";
import { ESPTOOL_TOOL } from "../desktop/esp/esptool";
import { preflightEspUpload } from "../desktop/esp/preflight";

// Real-hardware deploy preflight. Read-only: flash_id, a 0x8000 partition read and (when PyYAML is
// present) the eFuse summary. It never writes, erases or uploads. Use it to see exactly which
// findings a specific board would produce before pressing Deploy.
//   AETHER_ESP_PORT=COM4 AETHER_ESP_PROJECT=examples/platformio-esp32c3 \
//   AETHER_PLATFORMIO_CLI=... npm run smoke:esp:preflight
const ports = await SerialPort.list();
const wanted = process.env.AETHER_ESP_PORT?.trim().toUpperCase();
const port = wanted ? ports.find((item) => item.path.toUpperCase() === wanted)?.path ?? wanted : ports.find((item) => (item.vendorId ?? "").toLowerCase() === "303a")?.path;
const example = path.resolve(process.env.AETHER_ESP_PROJECT?.trim() || "examples/platformio-esp32c3");
const environment = process.env.AETHER_ESP_ENV?.trim() || "esp32-c3";
const platformio = process.env.AETHER_PLATFORMIO_CLI?.trim() || "platformio";

if (!port) {
  console.log("SKIP esp preflight: no ESP USB port found");
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-preflight-device-"));
  const tools = new ToolService(() => path.join(root, "tools.json"));
  const workspace = new WorkspaceService();
  tools.define(ESPTOOL_TOOL);
  try {
    // Copy only what the preflight reads: the project config and the real build artifacts.
    await fs.mkdir(path.join(root, ".pio", "build", environment), { recursive: true });
    await fs.copyFile(path.join(example, "platformio.ini"), path.join(root, "platformio.ini"));
    const artifacts = [];
    for (const name of ["firmware.bin", "bootloader.bin", "partitions.bin"]) {
      const source = path.join(example, ".pio", "build", environment, name);
      await fs.copyFile(source, path.join(root, ".pio", "build", environment, name));
      const bytes = await fs.readFile(source);
      artifacts.push({ path: ".pio/build/" + environment + "/" + name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await workspace.open(root);
    const inputHash = await workspace.fingerprint();
    await fs.mkdir(path.join(root, ".aether"), { recursive: true });
    await fs.writeFile(path.join(root, ".aether", "build.json"), JSON.stringify({ environment, inputHash, artifacts, status: "succeeded" }));
    const result = await preflightEspUpload({ root, environment, port, platformio, workspace, tools });
    assert.equal(result.supported, true, "the example project must be recognised as an ESP target: " + result.skipped);
    assert.ok(result.chip.detectedId !== null, "the real chip must be identified: " + result.findings.map((finding) => finding.id).join(","));
    assert.equal(result.segments.length >= 3, true, "the build must produce a bootloader/partition/app plan");
    // General safety invariant: a device layout that differs from the build layout may never pass silently.
    const differs = result.partitions.device.length > 0 && !samePartitionTable(result.partitions.device, result.partitions.build);
    if (differs) assert.equal(result.ok, false, "a different on-board partition layout must block the write");
    console.log("PASS esp preflight " + port + " (read-only, zero writes): device " + result.chip.detectedName + " rev " + result.chip.detectedRevision +
      " · flash " + (result.flash.detected ? result.flash.detected / 1048576 + "MB" : "?") + " · build target " + result.chip.expectedMcu +
      " · plan " + result.segments.map((segment) => segment.name + "@0x" + segment.offset.toString(16) + "/0x" + segment.size.toString(16)).join(",") +
      " · differed=" + differs + " · ok=" + result.ok);
    for (const finding of result.findings) console.log("  [" + finding.severity + "] " + finding.id + " — " + finding.title + "｜下一步：" + finding.next);
  } finally {
    await workspace.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
