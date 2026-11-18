import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskService, type TaskProvider } from "../desktop/tasks";
import { WorkspaceService } from "../desktop/workspace";
import {
  fingerprintOf, invalidateEnvironment, prepareBuildCache, resolvePartitionInputs, signatureFor,
  type ProjectConfig,
} from "../desktop/buildInputs";

const fixture = path.resolve("scripts/fixture-pio.mjs");
const read = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");
const exists = async (target: string) => fs.lstat(target).then(() => true, () => false);

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-build-inputs-")));
const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-build-inputs-outside-")));
const write = async (name: string, text: string) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); };
const ini = (extra = "") => `[platformio]
default_envs = env-a

[env:env-a]
platform = espressif32@6.12.0
board = board-a
${extra}

[env:env-b]
platform = espressif32@6.12.0
board = board-b
`;
// `pio project config --json-output` already expands [env] defaults and extends chains
// (including [common]) into the env section, so these entries mirror its real output.
const config: ProjectConfig = [
  ["env:env-a", [["platform", "espressif32@6.12.0"], ["board", "board-a"], ["board_build.partitions", "partitions.csv"]]],
  ["env:env-b", [["platform", "espressif32@6.12.0"], ["board", "board-b"]]],
  ["env:env-c", [["platform", "espressif32@6.12.0"], ["board_build.partitions", "env-c.csv"]]],
  ["env:env-d", [["platform", "espressif32@6.12.0"], ["board_build.partitions", "default"]]],
  ["env:env-extends", [["extends", ["env:env-c"]], ["board_build.partitions", "env-c.csv"]]],
  ["env:env-common", [["extends", ["common"]], ["board_build.partitions", "common.csv"]]],
  ["env:env-custom", [["board_build.partitions", "custom.csv"]]],
  ["env:env-default-shadow", [["board_build.partitions", "default.csv"]]],
  ["env:env-huge", [["board_build.partitions", "huge_app.csv"]]],
  ["common", [["board_build.partitions", "common.csv"]]],
];

let passed = 0;
const check = (name: string) => { passed++; console.log("  ✓ " + name); };

try {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await write("platformio.ini", ini());
  await write("partitions.csv", "old-table\n");
  await write("env-c.csv", "env-c-table\n");
  await write("common.csv", "common-table\n");
  await write("custom.csv", "custom-table\n");
  // A project file that shadows a built-in name: PlatformIO uses the platform table, not this file.
  await write("default.csv", "project-shadow-that-pio-ignores\n");
  await write("src/main.cpp", "int main() { return 0; }\n");

  // --- Resolution follows the env section from PIO's own output, including expanded extends.
  const fromEnv = await resolvePartitionInputs(root, config, "env-a");
  assert.deepEqual(fromEnv.map((item) => item.path), ["partitions.csv"]);
  assert.equal(fromEnv[0].source, "env:env-a");
  assert.equal(fromEnv[0].kind, "file");
  assert.deepEqual((await resolvePartitionInputs(root, config, "env-c")).map((item) => item.path), ["env-c.csv"]);
  assert.deepEqual((await resolvePartitionInputs(root, config, "env-extends")).map((item) => item.path), ["env-c.csv"], "expanded extends values are used");
  assert.deepEqual((await resolvePartitionInputs(root, config, "env-common")).map((item) => item.path), ["common.csv"], "[common] extends does not require env:common");
  assert.deepEqual(await resolvePartitionInputs(root, config, "env-b"), [], "no table option is recorded as none");
  check("env-section resolution (env defaults, extends, [common], none)");

  // --- Built-in names win over a project file of the same name; other project files are hashed.
  const builtin = await resolvePartitionInputs(root, config, "env-d");
  assert.deepEqual(builtin, [{ source: "env:env-d", kind: "builtin", path: null, name: "default", sha256: null }]);
  assert.deepEqual(await resolvePartitionInputs(root, config, "env-huge"), [{ source: "env:env-huge", kind: "builtin", path: null, name: "huge_app.csv", sha256: null }], "common built-ins are not rejected as missing project files");
  assert.deepEqual((await resolvePartitionInputs(root, config, "env-default-shadow")).map((item) => [item.kind, item.name]), [["builtin", "default.csv"]], "a project file shadowing default.csv is not treated as the active table");
  const custom = await resolvePartitionInputs(root, config, "env-custom");
  assert.equal(custom[0].kind, "file");
  assert.equal(custom[0].path, "custom.csv");
  check("built-in table names take PIO's precedence; custom project tables are read");

  // --- Path handling: ${PROJECT_DIR}, parent escape, unresolved interpolation and links.
  const projectDirConfig: ProjectConfig = [["env:env-a", [["board_build.partitions", "${PROJECT_DIR}/partitions.csv"]]]];
  assert.match(JSON.stringify(await resolvePartitionInputs(root, projectDirConfig, "env-a")), /partitions\.csv/);
  await assert.rejects(() => resolvePartitionInputs(root, [["env:env-a", [["board_build.partitions", "../escape.csv"]]]], "env-a"), /工程目录内/);
  await assert.rejects(() => resolvePartitionInputs(root, [["env:env-a", [["board_build.partitions", "${sysenv.HOME}/x.csv"]]]], "env-a"), /插值/);
  const linkTarget = path.join(outside, "linked-partitions.csv");
  await fs.writeFile(linkTarget, "linked\n");
  await fs.symlink(outside, path.join(root, "linked"), "junction");
  await assert.rejects(() => resolvePartitionInputs(root, [["env:env-a", [["board_build.partitions", "linked/linked-partitions.csv"]]]], "env-a"), /链接/);
  check("path boundary: ${PROJECT_DIR} allowed, escape/interpolation/junction refused");

  // --- Fingerprint stability and content sensitivity (the file name is not the key).
  const sig = signatureFor(root, "env-a", await read(root, "platformio.ini"), fromEnv);
  assert.equal(fingerprintOf(sig), fingerprintOf(signatureFor(root, "env-a", await read(root, "platformio.ini"), fromEnv)));
  assert.notEqual(fingerprintOf(sig), fingerprintOf(signatureFor(root, "env-a", await read(root, "platformio.ini"), [{ ...fromEnv[0], sha256: "x" }])));
  check("fingerprint is deterministic and content-sensitive");

  // --- First build records the inputs; an unchanged rebuild clears nothing.
  assert.equal(await prepareBuildCache(root, "env-a", config), "", "first build with no cache has nothing to move");
  const buildDir = path.join(root, ".pio", "build", "env-a");
  await fs.mkdir(buildDir, { recursive: true });
  await fs.writeFile(path.join(buildDir, "partitions.bin"), "STALE-table");
  await fs.writeFile(path.join(buildDir, "partitions.csv"), "STALE-copy");
  await fs.writeFile(path.join(buildDir, "firmware.bin"), "STALE-firmware");
  await fs.writeFile(path.join(buildDir, "bootloader.bin"), "STALE-bootloader");
  await fs.writeFile(path.join(buildDir, "firmware.elf"), "ELF-KEEP");
  await fs.writeFile(path.join(buildDir, "firmware.map"), "MAP-KEEP");
  const record = JSON.parse(await read(root, ".aether/build-config.json"));
  assert.equal(record.environments["env-a"].signature.partitions[0].path, "partitions.csv");
  assert.equal(await prepareBuildCache(root, "env-a", config), "", "identical inputs never clear the cache");
  assert.equal(await read(root, ".pio/build/env-a/partitions.bin"), "STALE-table");
  check("unchanged inputs do not invalidate the environment cache");

  // Another environment's cache must survive an invalidation of env-a.
  await fs.mkdir(path.join(root, ".pio", "build", "env-b"), { recursive: true });
  await fs.writeFile(path.join(root, ".pio", "build", "env-b", "partitions.bin"), "ENV-B-KEEP");

  // --- Changing the CSV content while the file name stays the same is detected and moved aside.
  await write("partitions.csv", "table-B\n");
  const note = await prepareBuildCache(root, "env-a", config);
  assert.match(note, /分区表已变化/);
  assert.match(note, /partitions\.bin/);
  for (const name of ["partitions.bin", "partitions.csv", "firmware.bin", "bootloader.bin"]) {
    assert.equal(await exists(path.join(buildDir, name)), false, name + " is moved out of the environment build dir");
  }
  assert.equal(await read(buildDir, "firmware.elf"), "ELF-KEEP", "the ELF stays (firmware.bin removal forces a relink)");
  assert.equal(await read(buildDir, "firmware.map"), "MAP-KEEP", "the map stays");
  assert.equal(await read(root, ".pio/build/env-b/partitions.bin"), "ENV-B-KEEP", "other environments are untouched");
  assert.equal(await read(root, ".pio/build/.aether-stale/env-a/partitions.bin"), "STALE-table", "old bytes are preserved, not deleted");
  assert.equal(await prepareBuildCache(root, "env-a", config), "", "the new inputs are recorded, so the next build clears nothing");
  check("same CSV filename with changed content invalidates only that environment; ELF/map stay");

  // --- A second change replaces the single quarantine copy instead of accumulating files.
  await fs.writeFile(path.join(buildDir, "partitions.bin"), "STALE-second");
  await write("partitions.csv", "table-C\n");
  assert.match(await prepareBuildCache(root, "env-a", config), /分区表已变化/);
  assert.equal(await read(root, ".pio/build/.aether-stale/env-a/partitions.bin"), "STALE-second", "the most recent stale copy is kept");
  const quarantined = (await fs.readdir(path.join(root, ".pio/build/.aether-stale/env-a"))).sort();
  assert.deepEqual(quarantined, ["bootloader.bin", "firmware.bin", "partitions.bin", "partitions.csv"], "one copy per generated file, no timestamp folders");
  check("quarantine keeps the most recent copy per file instead of growing");

  // --- An ini change is an input change for the selected environment.
  await fs.writeFile(path.join(buildDir, "partitions.bin"), "STALE-ini");
  await write("platformio.ini", ini("build_flags = -DAETHER=1"));
  assert.match(await prepareBuildCache(root, "env-a", config), /platformio\.ini 或分区表已变化/);
  assert.equal(await exists(path.join(buildDir, "partitions.bin")), false);
  check("platformio.ini edits invalidate the selected environment");

  // --- A cache that predates any record (manual PlatformIO use, copied project) is not trusted.
  await fs.mkdir(path.join(root, ".pio", "build", "env-c"), { recursive: true });
  await fs.writeFile(path.join(root, ".pio/build/env-c/partitions.bin"), "UNRECORDED");
  assert.match(await prepareBuildCache(root, "env-c", config), /没有配置记录/);
  assert.equal(await exists(path.join(root, ".pio/build/env-c/partitions.bin")), false);
  check("existing cache without a record is treated as stale once");

  // --- Links are refused at every boundary: env dir, .pio/build, the quarantine dir and .aether.
  const linkBuild = path.join(outside, "linked-build");
  await fs.mkdir(linkBuild, { recursive: true });
  await fs.writeFile(path.join(linkBuild, "partitions.bin"), "LINKED-KEEP");
  await fs.symlink(linkBuild, path.join(root, ".pio", "build", "env-e"), "junction");
  await assert.rejects(() => invalidateEnvironment(root, "env-e"), /符号链接/);
  assert.equal(await read(outside, "linked-build/partitions.bin"), "LINKED-KEEP");
  check("symlinked environment build directory is refused without touching the target");

  const linkedPio = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-linked-pio-")));
  const linkedProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-linked-project-")));
  await fs.writeFile(path.join(linkedProject, "platformio.ini"), ini());
  await fs.mkdir(path.join(linkedPio, "build", "env-a"), { recursive: true });
  await fs.writeFile(path.join(linkedPio, "build", "env-a", "partitions.bin"), "OUTSIDE-KEEP");
  await fs.symlink(linkedPio, path.join(linkedProject, ".pio"), "junction");
  await assert.rejects(() => invalidateEnvironment(linkedProject, "env-a"), /符号链接/, "a buildRoot that is itself a junction to a user tree is refused");
  assert.equal(await read(linkedPio, "build/env-a/partitions.bin"), "OUTSIDE-KEEP");
  check("a .pio junction outside the project is refused before moving anything");

  const staleLinkProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-stale-link-")));
  await fs.writeFile(path.join(staleLinkProject, "platformio.ini"), ini());
  await fs.mkdir(path.join(staleLinkProject, ".pio", "build", "env-a"), { recursive: true });
  await fs.writeFile(path.join(staleLinkProject, ".pio/build/env-a/partitions.bin"), "MOVE-ME");
  const staleOutside = path.join(outside, "stale-outside");
  await fs.mkdir(staleOutside, { recursive: true });
  await fs.mkdir(path.join(staleLinkProject, ".pio", "build", ".aether-stale"), { recursive: true });
  await fs.symlink(staleOutside, path.join(staleLinkProject, ".pio", "build", ".aether-stale", "env-a"), "junction");
  await assert.rejects(() => invalidateEnvironment(staleLinkProject, "env-a"), /符号链接/);
  assert.equal(await exists(path.join(staleOutside, "partitions.bin")), false);
  check("a linked quarantine directory is refused");

  const aetherLinkProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-aether-link-")));
  await fs.writeFile(path.join(aetherLinkProject, "platformio.ini"), ini());
  await fs.writeFile(path.join(aetherLinkProject, "partitions.csv"), "x\n");
  const aetherOutside = path.join(outside, "aether-outside");
  await fs.mkdir(aetherOutside, { recursive: true });
  await fs.symlink(aetherOutside, path.join(aetherLinkProject, ".aether"), "junction");
  await assert.rejects(() => prepareBuildCache(aetherLinkProject, "env-a", config), /符号链接/);
  assert.equal(await exists(path.join(aetherOutside, "build-config.json")), false);
  check("a linked .aether directory is refused");

  // --- A leftover .writing temp is reported instead of being overwritten.
  const writingProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-writing-")));
  await fs.writeFile(path.join(writingProject, "platformio.ini"), ini());
  await fs.writeFile(path.join(writingProject, "partitions.csv"), "x\n");
  await fs.mkdir(path.join(writingProject, ".aether"), { recursive: true });
  await fs.writeFile(path.join(writingProject, ".aether", "build-config.json.writing"), "leftover");
  await assert.rejects(() => prepareBuildCache(writingProject, "env-a", config), /临时构建配置记录已存在/);
  assert.equal(await read(writingProject, ".aether/build-config.json.writing"), "leftover", "the existing temp is not overwritten");
  check("a leftover .writing record is reported, never overwritten");

  // --- End to end: a stale table on disk never reaches the upload step.
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aether-build-inputs-task-")));
  const projectIni = "[env:env-a]\nplatform = espressif32@6.12.0\nboard = board-a\n";
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.writeFile(path.join(project, "platformio.ini"), projectIni);
  await fs.writeFile(path.join(project, "src", "main.cpp"), "int main() { return 0; }\n");
  await fs.writeFile(path.join(project, "partitions.csv"), "old-layout\n");
  const taskConfig: ProjectConfig = [["env:env-a", [["board_build.partitions", "partitions.csv"]]]];
  await prepareBuildCache(project, "env-a", taskConfig);
  await fs.mkdir(path.join(project, ".pio", "build", "env-a"), { recursive: true });
  await fs.writeFile(path.join(project, ".pio", "build", "env-a", "partitions.bin"), "PARTITION-TABLE:old-layout\n");
  await fs.writeFile(path.join(project, ".pio", "build", "env-a", "firmware.bin"), "OLD-FIRMWARE");
  await fs.writeFile(path.join(project, "partitions.csv"), "new-layout\n");

  const workspace = new WorkspaceService();
  workspace.root = project;
  const tasks = new TaskService(workspace);
  const provider = (id: string, extra: string[]): TaskProvider => ({
    id, executable: () => process.execPath, args: (options) => [fixture, ...extra, "-e", options.environment!],
    environments: async () => [{ name: "env-a", default: true }],
    beforeStart: (at, _executable, options) => prepareBuildCache(at, options.environment!, taskConfig),
    artifacts: async (at) => {
      const directory = path.join(at, ".pio", "build", "env-a");
      return (await fs.readdir(directory)).filter((name) => /\.(bin|elf)$/.test(name)).map((name) => ".pio/build/env-a/" + name);
    },
  });
  tasks.register(provider("fixture.build", ["run"]));
  tasks.register(provider("fixture.upload", ["run", "--target", "upload", "--upload-port", "FIXTURE-PORT"]));
  const wait = async (id: string) => {
    for (let n = 0; n < 3000; n++) {
      const task = tasks.list().find((item) => item.id === id)!;
      if (task.status !== "running") return task;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("task timeout");
  };
  try {
    const upload = await wait((await tasks.start("fixture.upload", { environment: "env-a" })).id);
    assert.equal(upload.status, "succeeded", (upload.error ?? "") + "\n" + upload.log);
    assert.match(upload.log, /\[aether\] 构建前检查：platformio\.ini 或分区表已变化/);
    assert.match(upload.log, /\[fixture\] generated partitions\.bin/);
    assert.doesNotMatch(upload.log, /reused existing partitions\.bin/);
    assert.equal(await exists(path.join(project, ".pio/fixture/stale-observed.json")), false, "the fixture never saw the old table");
    assert.equal(await read(project, ".pio/fixture/flashed-partitions.bin"), "PARTITION-TABLE:new-layout\n", "the uploaded table matches the current CSV");
    assert.equal(await read(project, ".pio/fixture/flashed-port.txt"), "FIXTURE-PORT");
    check("fixed fixture: changed CSV content is what reaches the upload, old table is never flashed");

    const again = await wait((await tasks.start("fixture.upload", { environment: "env-a" })).id);
    assert.equal(again.status, "succeeded", (again.error ?? "") + "\n" + again.log);
    assert.doesNotMatch(again.log, /\[aether\]/, "an unchanged rebuild does not clear the cache again");
    assert.equal(await read(project, ".pio/build/.aether-stale/env-a/partitions.bin"), "PARTITION-TABLE:old-layout\n", "the quarantined copy is untouched");
    check("repeat build with unchanged inputs logs no invalidation and moves nothing");

    // A preparation failure stops the task before any process starts.
    tasks.register({
      ...provider("fixture.refuse", ["run"]),
      environments: async () => [{ name: "env-refuse", default: true }],
      beforeStart: async () => { throw new Error("fixture: preparation refused"); },
    });
    const before = await read(project, ".pio/fixture/fixture-build.json");
    await assert.rejects(() => tasks.start("fixture.refuse", { environment: "env-refuse" }), /preparation refused/);
    assert.equal(await read(project, ".pio/fixture/fixture-build.json"), before, "no process ran after a preparation failure");
    check("pre-start failure prevents the process and leaves no task");
  } finally {
    await tasks.stopAll();
  }
  await fs.rm(project, { recursive: true, force: true });
  console.log("PASS build inputs: " + passed + " checks; PIO env-section resolution, built-in precedence, content-based invalidation, link boundaries and a fixed fixture; no hardware, no real PlatformIO");
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}
