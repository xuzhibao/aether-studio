import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ToolService } from "../desktop/tools";
import { acquirePort, releasePort } from "../desktop/portLease";
import { MicropythonFilesService, micropythonSuggestedName, parseMicropythonListing } from "../desktop/plugins/micropythonFiles";
import { micropythonTool } from "../desktop/plugins/micropython";
import {
  micropythonDownloadArgs, micropythonListArgs, micropythonRemotePath, micropythonChildPath, micropythonEntryName,
} from "../shared/micropython";

// Read-only board file browsing: parser boundaries (spaces, Chinese, empty directory, junk output),
// exact argv, host-issued single-use picker authorizations, scope/generation checks, the shared port
// lease, cancellation and cleanup. The fake CLI never opens a serial port.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-micropython-files-"));
const fake = path.resolve("scripts/fixtures/fake-mpremote.py");
const logPath = path.join(root, "fake-mpremote-calls.log");
const tools = new ToolService(() => path.join(root, "tools.json"));
const service = new MicropythonFilesService(tools);
let scoped: MicropythonFilesService | undefined;
const downloads = () => fs.readdir(os.tmpdir()).then((names) => names.filter((name) => name.startsWith("aether-micropython-download-"))) ;
const calls = async () => (await fs.readFile(logPath, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const cpCalls = async () => (await calls()).filter((entry) => !entry.version && entry.fs === "cp").length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clearEnv = () => { for (const key of ["AETHER_FAKE_MPREMOTE_LOG", "AETHER_FAKE_MPREMOTE_FS_MODE", "AETHER_FAKE_MPREMOTE_FS_MODE_FILE"]) delete process.env[key]; };
/** Opens the fake save dialog for one entry and returns the token; fails the smoke if no token was issued. */
const chooseTarget = async (target: string | null, remote = "/main.py", port = "COM_TEST", name = "main.py") => {
  const choice = await service.choose(port, remote, name, async () => target);
  if (choice.status !== "chosen") throw new Error("expected a picker authorization, got " + JSON.stringify(choice));
  return choice.token;
};

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
  assert.throws(() => parseMicropythonListing("", "COM_TEST", "/"), /目录头/, "empty output must not look like an empty directory");
  assert.throws(() => parseMicropythonListing("\r\n\r\n", "COM_TEST", "/"), /目录头/, "blank output must not look like an empty directory");
  assert.throws(() => parseMicropythonListing("ls :/\r\nls :/lib\r\n", "COM_TEST", "/"), /多个目录头/, "two headers are ambiguous");
  assert.deepEqual(parseMicropythonListing("ls :/\r\n           7  leading  space.txt\r\n", "COM_TEST", "/").entries, [{ name: " leading  space.txt", path: "/ leading  space.txt", type: "file", size: 7 }], "leading and repeated spaces are part of the name");
  assert.throws(() => parseMicropythonListing("ls :/\r\nthis is not an entry\r\n", "COM_TEST", "/"), /无法解析/);
  assert.throws(() => parseMicropythonListing("ls :/\r\n           0 lib/\r\n          12 ../escape\r\n", "COM_TEST", "/"), /条目/);
  assert.throws(() => parseMicropythonListing("ls :/lib\r\n           1 helper.py\r\n", "COM_TEST", "/"), /未返回预期的目录头/, "a header for another directory must not be shown");
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
  assert.equal(micropythonSuggestedName("a/b.txt"), "device-file.bin", "a suggested name may not carry a path");
  assert.equal(micropythonSuggestedName("x".repeat(300)).length, 120, "the suggested name is bounded");
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

  // ---- the picker returns only an opaque token, never a local path; the host stages the target ----
  let suggested = "";
  const target = path.join(root, "记录 copy.txt");
  const chosen = await service.choose("COM_TEST", "/数据 记录.txt", "数据 记录.txt", async (name) => { suggested = name; return target; });
  assert.deepEqual(Object.keys(chosen).sort(), ["status", "token"], "the renderer must not receive a local path");
  if (chosen.status !== "chosen") throw new Error("expected a chosen authorization: " + JSON.stringify(chosen));
  assert.match(chosen.token, /^[0-9a-f]{64}$/, "the authorization is an opaque random token");
  assert.equal(suggested, "数据 记录.txt", "the entry name is only a dialog suggestion");
  const downloaded = await service.download(chosen.token);
  assert.equal(downloaded.target, path.resolve(target));
  assert.equal(downloaded.size, 35);
  assert.equal(await fs.readFile(target, "utf8"), "temperature,pressure\r\n21.5,1013.2\r\n", "the downloaded bytes match the fake device file");
  const downloadCall = (await calls()).filter((entry) => !entry.version && entry.fs === "cp").at(-1);
  assert.deepEqual(downloadCall?.argv.slice(0, 5), ["connect", "port:COM_TEST", "resume", "fs", "cp"]);
  assert.ok(downloadCall.argv[5] === ":/数据 记录.txt", "the remote side is a single argv entry");
  assert.ok(!downloadCall.argv[6].includes("记录 copy"), "the device process writes into the private temp file, not the user target");
  assert.deepEqual(await downloads(), startDownloads, "a successful download removes its private temp directory");
  // Single use: replaying the token cannot start a second mpremote or write again.
  const cpAfterSuccess = await cpCalls();
  await assert.rejects(() => service.download(chosen.token), /授权无效或已使用/);
  assert.equal(await cpCalls(), cpAfterSuccess, "a replayed token starts no mpremote process");
  console.log("PASS micropython files: a single-use opaque token delivers the device bytes only after success");

  // ---- arbitrary/forged destinations are impossible: only a host-issued token is accepted ----
  await assert.rejects(() => service.download("0".repeat(64)), /授权无效/);
  await assert.rejects(() => service.download(path.join(root, "forged.bin")), /授权无效/, "a renderer-supplied local path is not a token");
  let dialogs = 0;
  const invalidPort = await service.choose("auto", "/main.py", "main.py", async () => { dialogs++; return null; });
  if (invalidPort.status !== "failed") throw new Error("an invalid port must be refused: " + JSON.stringify(invalidPort));
  assert.match(invalidPort.error, /不能使用 auto 或 list/, "an invalid port is refused before the dialog opens");
  const invalidPath = await service.choose("COM_TEST", "/lib/../etc", "main.py", async () => { dialogs++; return null; });
  assert.equal(invalidPath.status, "failed");
  assert.equal(dialogs, 0, "invalid scope never opens a save dialog");
  console.log("PASS micropython files: forged tokens and invalid scopes are refused; a local path never selects a target");

  // ---- an existing file is never overwritten ----
  const keep = path.join(root, "keep.txt");
  await fs.writeFile(keep, "KEEP");
  const keepToken = await chooseTarget(keep);
  await assert.rejects(() => service.download(keepToken), /目标文件已存在，未覆盖/);
  assert.equal(await fs.readFile(keep, "utf8"), "KEEP");
  console.log("PASS micropython files: an existing local file is refused, not overwritten");

  // ---- a device-side failure creates no target and removes the temp directory ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "fail";
  const broken = path.join(root, "broken.bin");
  const brokenToken = await chooseTarget(broken);
  await assert.rejects(() => service.download(brokenToken), /退出码 5/);
  assert.equal(await fs.stat(broken).catch(() => null), null, "a failed transfer writes nothing");
  assert.deepEqual(await downloads(), startDownloads, "a failed transfer removes its temp directory");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  console.log("PASS micropython files: a device failure writes no target and cleans the private temp file");

  // ---- cancellation aborts the process, cleans temp and releases the port ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "slow";
  const cancelledTarget = path.join(root, "cancelled.bin");
  const cancelledToken = await chooseTarget(cancelledTarget);
  const cpBefore = await cpCalls();
  const pending = service.download(cancelledToken);
  for (let n = 0; n < 100 && (await cpCalls()) <= cpBefore; n++) await sleep(100);
  assert.equal(service.cancel(), true, "cancel aborts the in-flight operation");
  await assert.rejects(pending, /操作已取消/);
  assert.equal(await fs.stat(cancelledTarget).catch(() => null), null);
  assert.deepEqual(await downloads(), startDownloads, "cancellation removes its temp directory");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  // The process is really gone before the promise settles: nothing is written late and the port is free.
  await sleep(1300);
  assert.equal(await fs.stat(cancelledTarget).catch(() => null), null, "a cancelled transfer never writes its target later");
  assert.deepEqual(await downloads(), startDownloads, "a cancelled transfer creates no temp directory later");
  assert.doesNotThrow(() => { releasePort(acquirePort("COM_TEST", "monitor")); }, "cancellation releases the shared port lease");
  assert.ok((await service.list("COM_TEST", "/")).entries.length > 0, "the port can be used again immediately after a cancel");
  console.log("PASS micropython files: cancellation kills mpremote, settles after exit, cleans temp and releases the port lease");

  // ---- the shared port lease blocks a second reader and is held through the operation ----
  const busyLease = acquirePort("COM_TEST", "task");
  await assert.rejects(() => service.list("COM_TEST", "/"), /占用/);
  const busyTarget = path.join(root, "busy.bin");
  const busyToken = await chooseTarget(busyTarget);
  await assert.rejects(() => service.download(busyToken), /占用/, "a busy port refuses the download before any file is touched");
  assert.equal(await fs.stat(busyTarget).catch(() => null), null);
  releasePort(busyLease);
  const first = service.list("COM_TEST", "/");
  await assert.rejects(() => service.list("COM_TEST", "/lib"), /已有正在读取设备文件的操作/);
  await first;
  console.log("PASS micropython files: the shared port lease and one-operation-at-a-time rule hold");

  // ---- one picker at a time: a duplicate click never opens a second dialog ----
  let releaseFirst: (value: string | null) => void = () => {};
  const firstPick = new Promise<string | null>((resolve) => { releaseFirst = resolve; });
  const firstChoice = service.choose("COM_TEST", "/main.py", "main.py", () => firstPick);
  let secondDialogs = 0;
  const secondChoice = await service.choose("COM_TEST", "/main.py", "main.py", async () => { secondDialogs++; return path.join(root, "second.bin"); });
  assert.equal(secondDialogs, 0, "the duplicate click must not open a second save dialog");
  if (secondChoice.status !== "failed") throw new Error("the duplicate picker attempt must be refused: " + JSON.stringify(secondChoice));
  assert.match(secondChoice.error, /保存对话框正在打开/);
  releaseFirst(null);
  assert.deepEqual(await firstChoice, { status: "cancelled", reason: "picker" }, "the dialog cancel is reported as such");
  // cancel then retry: a cancelled picker leaves nothing behind and a new picker works normally.
  const retryTarget = path.join(root, "retry.txt");
  const retryToken = await chooseTarget(retryTarget);
  const retryResult = await service.download(retryToken);
  assert.equal(await fs.readFile(retryTarget, "utf8"), "print('hello from the fake board')\n", "the retried download writes the fake main.py bytes");
  assert.equal(retryResult.size, Buffer.byteLength("print('hello from the fake board')\n", "utf8"));
  assert.equal(await fs.stat(retryTarget).then((stat) => stat.isFile()), true);
  console.log("PASS micropython files: duplicate picker attempts are refused; cancelling a dialog is distinct from failure and retry works");

  // ---- a picker reply that arrives after invalidation starts no mpremote and writes nothing ----
  const staleTarget = path.join(root, "stale.bin");
  let releaseStale: (value: string | null) => void = () => {};
  const stalePick = new Promise<string | null>((resolve) => { releaseStale = resolve; });
  const staleChoice = service.choose("COM_TEST", "/main.py", "main.py", () => stalePick);
  const cpBeforeStale = await cpCalls();
  await service.invalidate();
  releaseStale(staleTarget);
  assert.deepEqual(await staleChoice, { status: "cancelled", reason: "invalidated" }, "an invalidated picker reply must not authorize a download");
  await sleep(300);
  assert.equal(await cpCalls(), cpBeforeStale, "an invalidated picker reply never starts mpremote");
  assert.equal(await fs.stat(staleTarget).catch(() => null), null, "an invalidated picker reply writes no file");
  console.log("PASS micropython files: a stale picker reply after invalidation starts no process and publishes nothing");

  // ---- a workspace switch retires an authorization issued for the previous workspace ----
  let workspace: string | null = "C:/work/before";
  scoped = new MicropythonFilesService(tools, { workspaceRoot: () => workspace });
  const scopeTarget = path.join(root, "scope.bin");
  const scopedChoice = await scoped.choose("COM_TEST", "/main.py", "main.py", async () => scopeTarget);
  if (scopedChoice.status !== "chosen") throw new Error("expected a scoped authorization");
  workspace = "C:/work/after";
  await assert.rejects(() => scoped.download(scopedChoice.token), /工程或面板已变化，保存授权已失效/);
  assert.equal(await fs.stat(scopeTarget).catch(() => null), null);
  // The picker itself is also checked against the workspace captured before the dialog opened.
  let releaseScoped: (value: string | null) => void = () => {};
  const scopedPick = new Promise<string | null>((resolve) => { releaseScoped = resolve; });
  const scopedPending = scoped.choose("COM_TEST", "/main.py", "main.py", () => scopedPick);
  workspace = "C:/work/other";
  releaseScoped(scopeTarget);
  assert.deepEqual(await scopedPending, { status: "cancelled", reason: "invalidated" }, "a workspace switch during the dialog retires the reply");
  await scoped.dispose();
  scoped = undefined;
  console.log("PASS micropython files: a workspace switch retires picker replies and issued authorizations");

  // ---- outstanding authorizations are bounded; the oldest one is evicted ----
  const tokens: string[] = [];
  for (let n = 0; n < 5; n++) tokens.push(await chooseTarget(path.join(root, "bounded-" + n + ".bin")));
  await assert.rejects(() => service.download(tokens[0]), /授权无效/, "the oldest outstanding authorization is evicted");
  assert.equal((await service.download(tokens[4])).size, Buffer.byteLength("print('hello from the fake board')\n", "utf8"), "the newest authorization still works");
  console.log("PASS micropython files: outstanding picker authorizations are bounded to a small fixed number");

  // ---- abnormal output is reported, not displayed ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "garbage";
  await assert.rejects(() => service.list("COM_TEST", "/"), /无法解析/);
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "mismatch";
  await assert.rejects(() => service.list("COM_TEST", "/"), /目录头/);
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  console.log("PASS micropython files: unparseable or mismatched ls output is refused with an explicit error");

  // ---- a multi-byte Chinese name split across two writes is decoded intact ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "split";
  const split = await service.list("COM_TEST", "/");
  assert.deepEqual(split.entries, [{ name: "数据 记录.txt", path: "/数据 记录.txt", type: "file", size: 35 }], "a UTF-8 sequence split across chunks must not corrupt the name");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  console.log("PASS micropython files: a multi-byte name split across pipe chunks is decoded correctly");

  // ---- a timeout settles only after the process is gone, with no late write and a free port ----
  const shortService = new MicropythonFilesService(tools, { downloadTimeoutMs: 600 });
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "slow";
  const timeoutTarget = path.join(root, "timeout.bin");
  const timeoutChoice = await shortService.choose("COM_TEST", "/main.py", "main.py", async () => timeoutTarget);
  if (timeoutChoice.status !== "chosen") throw new Error("expected a timeout Test authorization");
  await assert.rejects(() => shortService.download(timeoutChoice.token), /超时/);
  await sleep(1800);
  assert.equal(await fs.stat(timeoutTarget).catch(() => null), null, "a timed-out transfer never writes its target later");
  assert.deepEqual(await downloads(), startDownloads, "a timed-out transfer creates no temp directory later");
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "ok";
  assert.doesNotThrow(() => { releasePort(acquirePort("COM_TEST", "monitor")); }, "a timeout releases the shared port lease");
  assert.ok((await shortService.list("COM_TEST", "/")).entries.length > 0, "the port can be used again right after a timeout");
  await shortService.dispose();
  console.log("PASS micropython files: a timeout settles after the process exits, leaves no late write and releases the port");

  // ---- dispose cleans a temp directory left behind by an interrupted transfer ----
  process.env.AETHER_FAKE_MPREMOTE_FS_MODE = "slow";
  const orphanTarget = path.join(root, "orphan.bin");
  const orphanToken = await chooseTarget(orphanTarget);
  const hanging = service.download(orphanToken);
  for (let n = 0; n < 100 && (await downloads()).length === startDownloads.length; n++) await sleep(100);
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
  await scoped?.dispose().catch(() => {});
  await service.dispose().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
