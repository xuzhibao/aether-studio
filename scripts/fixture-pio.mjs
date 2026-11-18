// Fixed PlatformIO stand-in for tests. It models the failure the acceptance report observed:
// when `.pio/build/<env>/partitions.bin` already exists, PlatformIO keeps using it instead of
// regenerating the table from `partitions.csv`. The test asserts that Aether's pre-build check
// moves that file away before this process starts, so the "flashed" table always matches the CSV.
// Observations are written under `.pio/` so the workspace fingerprint (which ignores tool caches) is stable.
import { promises as fs } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const observations = path.join(process.cwd(), ".pio", "fixture");
const note = async (name, text) => { await fs.mkdir(observations, { recursive: true }); await fs.writeFile(path.join(observations, name), text, "utf8"); };

if (args.includes("--version")) {
  process.stdout.write("PlatformIO Core, version 0.0.0-fixture\n");
  process.exit(0);
}
if (args[0] === "project") {
  // The tests supply the parsed config directly; metadata queries have nothing to add.
  process.stdout.write("{}\n");
  process.exit(0);
}

const environment = option("-e");
if (!environment) { process.stderr.write("fixture: missing -e\n"); process.exit(2); }
const build = path.join(process.cwd(), ".pio", "build", environment);
const existing = path.join(build, "partitions.bin");
const csv = await fs.readFile(path.join(process.cwd(), "partitions.csv"), "utf8").catch(() => null);
if (csv === null) { process.stderr.write("fixture: partitions.csv missing\n"); process.exit(3); }
await fs.mkdir(build, { recursive: true });

let table;
const stale = await fs.readFile(existing).catch(() => null);
if (stale !== null) {
  // This is the stale-cache behavior the product must prevent.
  await note("stale-observed.json", JSON.stringify({ environment, source: ".pio/build/" + environment + "/partitions.bin", content: stale.toString("utf8") }, null, 2));
  await note("stale-partitions.bin", stale);
  table = stale;
  process.stdout.write("[fixture] reused existing partitions.bin (" + stale.length + " bytes)\n");
} else {
  table = Buffer.from("PARTITION-TABLE:" + csv, "utf8");
  await fs.writeFile(existing, table);
  process.stdout.write("[fixture] generated partitions.bin from partitions.csv\n");
}
const firmware = Buffer.from("FIRMWARE-FOR:" + table.toString("utf8"), "utf8");
await fs.writeFile(path.join(build, "firmware.bin"), firmware);
await note("fixture-build.json", JSON.stringify({ environment, table: table.toString("utf8"), firmware: firmware.toString("utf8") }, null, 2));

if (option("--target") === "upload") {
  const port = option("--upload-port") ?? "";
  const flashed = await fs.readFile(existing);
  await note("flashed-partitions.bin", flashed);
  await note("flashed-port.txt", port);
  process.stdout.write("[fixture] upload wrote " + flashed.length + " partition bytes to " + port + "\n");
}
process.exit(0);
