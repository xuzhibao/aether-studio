import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ToolService } from "../desktop/tools";
import { acquirePort, releasePort } from "../desktop/portLease";
import { MicropythonFilesService, parseMicropythonListing } from "../desktop/plugins/micropythonFiles";
import { micropythonTool } from "../desktop/plugins/micropython";
import {
  micropythonDownloadArgs, micropythonListArgs, micropythonRemotePath, micropythonChildPath, micropythonEntryName,
} from "../shared/micropython";

// Read-only board file browsing: parser boundaries (spaces, Chinese, empty directory, junk output),
// exact argv, shared port lease, cancellation and cleanup. The fake CLI never opens a serial port.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-files-"));
const fake = path.resolve("scripts/fixtures/fake-mpremote.py");
const logPath = path.join(root, "fake-mpremote-calls.log");
const tools = new ToolService(() => path.join(root, "tools.json"));
const service = new MicropythonFilesService(tools);
const downloads = () => fs.readdir(os.tmpdir()).then((names) => names.filter((name) => name.startsWith("aether-micropython-download-"))) ;
const calls = async () => (await fs.readFile(logPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const clearEnv = () => { for (const key of ["AETHER_FAKE_MPREMOTE_LOG", "AETHER_FAKE_MPREMOTE_FS_MODE", "AETHER_FAKE_MPREMOTE_FS_MODE_FILE"]) delete process.env[key]; };

try {
  // ---- parser: exact mpremote 1.29.0 format, spaces, Chinese, empty directory ----
  const listing = parseMicropythonListing([
    "ls :/",
    "           0 boot.py",
    "           0 lib/",
    "         214 main.py",
    "           0 空 目录/",
    "          42 数据 记录.txt",
    "",
  ].join("\r\n"), "COM_TEST", "/");
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.type, entry.size]), [
    ["boot.py", "file", 0], ["lib", "directory", 0], ["main.py", "file", 214], ["空 目录", "directory", 0], ["数据 记录.txt", "file", 42],
  ]);
  assert.equal(listing.entries[4].path, "/数据 记录.txt", "a child path is the validated parent plus the literal name");
  assert.deepEqual(parseMicropythonListing("ls :/空 目录\r\n", "COM_TEST", "/空 目录").entries, [], "an empty directory has no entry lines");
  assert.deepEqual(parseMicropythonListing("           7  leading  space.txt\r\n", "COM_TEST", "/").entries, [{ name: " leading  space.txt", path: "/ leading  space.txt", type: "file", size: 7 }], "leading and repeated spaces are part of the name");
  assert.throws(() => parseMicropythonListing("this is not an entry\n", "COM_TEST", "/"), /无法解析/);
  assert.throws(() => parseMicropythonListing("           0 lib/\n          12 ../escape\n", "COM_TEST", "/"), /条目/);
  assert.throws(() => parseMicropythonListing("ls :/lib\n           1 helper.py\n", "COM_TEST", "/"), /目录与请求不一致/, "a header for another directory must not be shown");
  console.log("PASS micropython files: ls parser keeps spaces/Chinese/empty directories and refuses junk or a mismatched header");

  // ---- host-side path validation and exact argv ----
  assert.deepEqual(micropythonListArgs("COM_TEST", "/lib/sub dir"), ["connect", "port:COM_TEST", "resume", "fs", "ls", "/lib/sub dir"]);
  assert.deepEqual(micropythonDownloadArgs("COM_TEST", "/数据 记录.txt", path.join(root, "out.bin")), ["connect", "port:COM_TEST", "resume", "fs", "cp", ":/数据 记录.txt", path.join(root, "out.bin")]);
  for (const value of ["", "lib", "//lib", "/lib/../etc", "/lib/./x", "/lib\\x", "/lib\nx", "auto"]) {
    assert.throws(() => micropythonRemotePath(value), /设备|路径|选择/);
  }
  assert.equal(micropythonRemotePath("/"), "/");
  assert.equal(micropythonChildPath("/", "lib"), "/lib");
  for (const value of ["", "a/b", "a\\b", "..", ".", "x\ny"]) assert.throws(() => micropythonEntryName(value), /条目/);
  assert.throws(() => micropythonListArgs("auto", "/"), /不能使用 auto 或 list/);
  console.log("PASS micropython files: absolute POSIX path and single-segment name validation, fixed argv");

  // ---- tool status through the shared ToolService, including --version ----
  tools.define(micropythonTool);
  await tools.load();
  await tools.setPath("mpremote", fake);
  const status = await tools.status("mpremote", true);
  assert.equal(status.available, true, status.error);
  assert.equal(status.version, "mpremote 9.9.9");
  process.env.AETHER_FAKE_MPREMOTE_LOG = logPath;
  console.log("PASS micropython files: mpremote tool status and --version probe");

  // ---- list the root, a directory with spaces/Chinese and an empty directory ----
  const startDownloads = await downloads();
  const rootListing = await service.list("COM_TEST", "/");
  assert.equal(rootListing.path, "/");
  assert.deepEqual(rootListing.entries.map((entry) => entry.name), ["boot.py", "lib", "main.py", "空 目录", "数据 记录.txt"]);
  const nested = await service.list("COM_TEST", "/lib/sub dir");
  assert.deepEqual(nested.entries.map((entry) => entry.name), ["深 层.py"]);
  assert.equal(nested.entries[0].path, "/lib/sub dir/深 层.py");
  const empty = await service.list("COM_TEST", "/空 目录");
  assert.deepEqual(empty.entries, [], "an empty directory lists as empty");
  const listCalls = await calls();
  assert.deepEqual(listCalls.at(-1)?.argv, ["connect", "port:COM_TEST", "resume", "fs", "ls", "/空 目录"]);
  assert.equal(listCalls.filter((entry) => !entry.version).every((entry) => entry.fs === "ls"), true);
  console.log("PASS micropython files: root/subdirectory/empty-directory listings use plain resume fs ls argv");

  // ---- download succeeds into a host-issued target and leaves no temp directory ----
  const target = path.join(root, "记录 copy.txt");
  service.issueTarget(target);
  const downloaded = await service.download("COM_TEST", "/数据 记录.txt", target);
  assert.equal(downloaded.target, path.resolve(target));
  assert.equal(downloaded.size, 35);
  assert.equal(await fs.readFile(target, "utf8"), "temperature,pressure\r\n21.5,1013.2\r\n", "the downloaded bytes match the fake device file");
  const downloadCall = (await calls()).filter((entry) => !entry.version && entry.fs === "cp").at(-1);
  assert.deepEqual(downloadCall?.argv.slice(0, 5), ["connect", "port:COM_TEST", "resume", "fs", "cp"]);
  assert.ok(downloadCall.argv[5] === ":/数据 记录.txt", "the remote side is a single argv entry");
  assert.ok(!downloadCall.argv[6].includes("记录 copy"), "the device process writes into the private temp file, not the user target");
  assert.deepEqual(await downloads(), startDownloads, "a successful download removes its private temp directory");
  console.log("PASS micropython files: download delivers the device bytes only after success and cleans its temp file");

  // ---- an existing file is never overwritten, and a forged target is refused ----
  const keep = path.join(root, "keep.txt");
  await fs.writeFile(keep, "KEEP");
  service.issueTarget(keep);
  await assert.rejects(() => service.download("COM_TEST", "/main.py", keep), /目标文件已存在，未覆盖/);
  assert.equal(await fs.readFile(keep, "utf8"), "KEEP");
  await assert.rejects(() => service.download("COM_TEST", "/main.py", path.join(root, "forged.bin")), /保存对话框/);
  console.log("PASS micropython files: an existing local file and an unissued path are both refused");

  // ---- a device-side failure creates no target and removes the temp directory ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "fail";
  const broken = path.join(root, "broken.bin");
  service.issueTarget(broken);
  await assert.rejects(() => service.download("COM_TEST", "/main.py", broken), /退出码 5/);
  assert.equal(await fs.stat(broken).catch(() => null), null, "a failed transfer writes nothing");
  assert.deepEqual(await downloads(), startDownloads, "a failed transfer removes its temp directory");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  console.log("PASS micropython files: a device failure writes no target and cleans the private temp file");

  // ---- cancellation aborts the process, cleans temp and releases the port ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "slow";
  const cancelledTarget = path.join(root, "cancelled.bin");
  service.issueTarget(cancelledTarget);
  const cpBefore = (await calls()).filter((entry) => entry.fs === "cp").length;
  const pending = service.download("COM_TEST", "/main.py", cancelledTarget);
  for (let n = 0; n < 100 && (await calls()).filter((entry) => entry.fs === "cp").length <= cpBefore; n++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(service.cancel(), true, "cancel aborts the in-flight operation");
  await assert.rejects(pending, /操作已取消/);
  assert.equal(await fs.stat(cancelledTarget).catch(() => null), null);
  assert.deepEqual(await downloads(), startDownloads, "cancellation removes its temp directory");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  assert.doesNotThrow(() => { acquirePort("COM_TEST", "monitor"); releasePort("COM_TEST"); }, "cancellation releases the shared port lease");
  console.log("PASS micropython files: cancellation kills mpremote, cleans temp and releases the port lease");

  // ---- the shared port lease blocks a second reader and is held through the operation ----
  acquirePort("COM_TEST", "task");
  await assert.rejects(() => service.list("COM_TEST", "/"), /占用/);
  releasePort("COM_TEST");
  const first = service.list("COM_TEST", "/");
  await assert.rejects(() => service.list("COM_TEST", "/lib"), /已有正在读取设备文件的操作/);
  await first;
  console.log("PASS micropython files: the shared port lease and one-operation-at-a-time rule hold");

  // ---- abnormal output is reported, not displayed ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "garbage";
  await assert.rejects(() => service.list("COM_TEST", "/"), /无法解析/);
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "mismatch";
  await assert.rejects(() => service.list("COM_TEST", "/"), /目录与请求不一致/);
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  console.log("PASS micropython files: unparseable or mismatched ls output is refused with an explicit error");

  // ---- dispose cleans a temp directory left behind by an interrupted transfer ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "slow";
  const orphanTarget = path.join(root, "orphan.bin");
  service.issueTarget(orphanTarget);
  const hanging = service.download("COM_TEST", "/main.py", orphanTarget);
  for (let n = 0; n < 100 && (await downloads()).length === startDownloads.length; n++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await downloads()).length > startDownloads.length, "the slow transfer has a temp directory");
  await service.dispose();
  await assert.rejects(hanging, /操作已取消/);
  assert.deepEqual(await downloads(), startDownloads, "dispose removes the private temp directory");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  console.log("PASS micropython files: dispose cancels an in-flight transfer and removes its temp directory");

  // ---- real CLI: the locked mpremote accepts this argv shape without a device ----
  const realTools = new ToolService(() => path.join(root, "real-tools.json"));
  realTools.define(micropythonTool);
  const realStatus = await realTools.status("mpremote", true);
  if (!realStatus.available) {
    console.log("SKIP micropython files: real mpremote (" + realStatus.error + ")");
  } else if (/fake-mpremote/i.test(realStatus.executable)) {
    console.log("SKIP micropython files: real mpremote (AETHER_MPREMOTE points at the fixture)");
  } else {
    assert.match(realStatus.version, /^mpremote\s+\d+\.\d+\.\d+/, "real mpremote --version: " + realStatus.version);
    const real = await promisify(execFile)(realStatus.executable, micropythonListArgs("COM_NOT_A_REAL_PORT_6", "/"), { timeout: 20000, windowsHide: true }).then(
      () => ({ code: 0, text: "" }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, text: (error.stderr ?? "") + (error.stdout ?? "") }),
    );
    // The real parser accepted `connect port:… resume fs ls /`; it fails only when opening the port.
    assert.notEqual(real.code, 0, "a port that does not exist must not look like a successful listing");
    assert.match(real.text, /failed to access|No such file|could not open|Permission/i, "unexpected real mpremote error: " + real.text);
    console.log("PASS micropython files: real mpremote " + realStatus.version.trim() + " accepts the resume fs ls argv (no device touched)");
  }
} finally {
  clearEnv();
  await service.dispose().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
