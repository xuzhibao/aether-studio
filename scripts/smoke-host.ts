import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceService } from "../desktop/workspace";
import { TaskService } from "../desktop/tasks";
import { createPlatformioPlugins } from "../desktop/plugins/platformio";
import { ToolService } from "../desktop/tools";
import type { ProjectContext } from "../src/plugins/api";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-host-"));
const workspace = new WorkspaceService();
const context: ProjectContext = { project: { id: "host-smoke", name: "Host smoke", description: "Actual local build", board: "", template: "", accent: "#007AFF", updated: "Local" }, components: [], wires: [], files: { "platformio.ini": await fs.readFile("examples/platformio-native/platformio.ini", "utf8"), "src/main.cpp": await fs.readFile("examples/platformio-native/src/main.cpp", "utf8") }, capabilities: { board: "", toolchain: "platformio", editor: "monaco", simulator: "" } };
const tasks = new TaskService(workspace);
const tools = new ToolService(() => path.join(directory, "tool-settings.json"));
const platformio = createPlatformioPlugins(tools);
await tools.load();
// Directory junctions need no elevation on Windows and behave as links for the workspace boundary checks.
const linkDirectory = async (target: string, link: string) => {
  const types: ("dir" | "junction")[] = process.platform === "win32" ? ["junction", "dir"] : ["dir"];
  for (const [index, type] of types.entries()) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await fs.symlink(target, link, type); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EBUSY" && attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 120)); continue; }
        if (index === types.length - 1) throw error;
        break;
      }
    }
  }
};
const waitTask = async (id: string) => { for (let n = 0; n < 1800; n++) { const task = tasks.list().find((task) => task.id === id)!; if (task.status !== "running") return task; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Task timeout"); };
try {
  await workspace.saveAs(directory, context);
  assert.equal(await fs.readFile(path.join(directory, "src/main.cpp"), "utf8"), context.files["src/main.cpp"]);
  const reopened = await workspace.reload(); assert.equal(reopened.context.project.name, "Host smoke");
  await fs.writeFile(path.join(directory, "src/main.cpp"), "// external edit\n");
  await assert.rejects(() => workspace.save(context), /外部修改/);
  assert.equal(await fs.readFile(path.join(directory, "src/main.cpp"), "utf8"), "// external edit\n");
  await workspace.reload(); await workspace.save(context);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aether-outside-"));
  await linkDirectory(outside, path.join(directory, "linked"));
  await assert.rejects(() => workspace.save({ ...context, files: { ...context.files, "linked/escape.cpp": "not written" } }), /链接/);
  await assert.rejects(() => fs.stat(path.join(outside, "escape.cpp")), { code: "ENOENT" });
  await fs.rm(path.join(directory, "linked")); await fs.rm(outside, { recursive: true });
  const toolStatus = await tools.status("platformio");
  assert.equal(toolStatus.available, true, toolStatus.error);
  assert.equal(toolStatus.source, process.env.AETHER_PLATFORMIO_CLI ? "environment" : "path");
  assert.match(toolStatus.version, /PlatformIO/, "actual PlatformIO --version output");
  tasks.register(platformio.platformioBuild);
  // Isolated project: real disk create/rename/trash and empty-directory persistence.
  const managed = await fs.mkdtemp(path.join(os.tmpdir(), "aether-files-"));
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "aether-bin-"));
  const trashed: string[] = [];
  const files = new WorkspaceService(undefined, async (target) => {
    const destination = path.join(bin, path.relative(managed, target));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(target, destination);
    trashed.push(target);
  });
  try {
    await files.saveAs(managed, context);
    await files.createDirectory("空 目录");
    await files.createDirectory("src/nested");
    await files.createFile("空 目录/说明 文档.md");
    await files.write("空 目录/说明 文档.md", "你好，磁盘\n", "");
    assert.equal(await fs.readFile(path.join(managed, "空 目录/说明 文档.md"), "utf8"), "你好，磁盘\n");
    let listing = await files.listing();
    assert.ok(listing.directories.includes("空 目录"));
    assert.ok(listing.directories.includes("src/nested"), "empty directories are listed");
    assert.equal(listing.files["空 目录/说明 文档.md"], "你好，磁盘\n");

    await files.reload();
    listing = await files.listing();
    assert.ok(listing.directories.includes("src/nested"), "empty directory survives reopening");
    assert.ok(listing.directories.includes("空 目录"));

    await files.rename("空 目录", "重命名 目录");
    assert.equal(await fs.stat(path.join(managed, "空 目录")).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(managed, "重命名 目录/说明 文档.md"), "utf8"), "你好，磁盘\n");
    await files.rename("重命名 目录/说明 文档.md", "重命名 目录/新 名字.md");
    assert.equal(await fs.readFile(path.join(managed, "重命名 目录/新 名字.md"), "utf8"), "你好，磁盘\n");
    await files.reload();
    listing = await files.listing();
    assert.ok(listing.directories.includes("重命名 目录"));
    assert.ok(!listing.directories.includes("空 目录"));

    await assert.rejects(() => files.createFile("src/nested"), /已存在/);
    await assert.rejects(() => files.createDirectory("src/nested"), /已存在/);
    await assert.rejects(() => files.rename("src/nested", "src"), /已存在/);
    await assert.rejects(() => files.createFile("../escape.txt"), /路径/);
    await assert.rejects(() => files.createFile(".git/config"), /缓存/);
    await assert.rejects(() => files.trash(""), /路径/);
    await assert.rejects(() => files.trash("hardware"), /宿主管理/);
    await assert.rejects(() => files.rename("hardware", "hw"), /宿主管理/);
    await assert.rejects(() => files.createFile("circuit.json"), /宿主管理/);

    // Case-insensitive filesystem aliases must not reach ignored or host-owned paths.
    if (process.platform === "win32" || process.platform === "darwin") {
      await fs.mkdir(path.join(managed, ".git"), { recursive: true });
      await fs.writeFile(path.join(managed, ".git", "config"), "protected\n");
      await assert.rejects(() => files.write(".GIT/config", "hacked\n", "protected\n"), /缓存/);
      await assert.rejects(() => files.trash(".GIT"), /缓存/);
      await assert.rejects(() => files.createFile("HARDWARE/evil.txt"), /宿主管理/);
      await assert.rejects(() => files.rename("HARDWARE", "hw"), /宿主管理/);
      await assert.rejects(() => files.save({ ...context, files: { "AETHER.PROJECT.JSON": "x" } }), /宿主管理/);
      await assert.rejects(() => files.save({ ...context, files: { "HARDWARE/evil.txt": "x" } }), /宿主管理/);
      await assert.rejects(() => files.save({ ...context, files: { ".GIT/config": "x" } }), /缓存/);
      assert.equal(await fs.readFile(path.join(managed, ".git", "config"), "utf8"), "protected\n");
      // A real case-only rename of the same file still works and keeps its content.
      await files.write("Case Keep.txt", "keep\n", null);
      await files.rename("Case Keep.txt", "case keep.txt");
      assert.equal(await fs.readFile(path.join(managed, "case keep.txt"), "utf8"), "keep\n");
    } else {
      // On a case-sensitive filesystem two names differing only by case are different files and must both survive.
      await files.write("case-a.txt", "lower\n", null);
      await files.write("Case-a.txt", "upper\n", null);
      await assert.rejects(() => files.rename("case-a.txt", "Case-a.txt"), /已存在/);
      assert.equal(await fs.readFile(path.join(managed, "case-a.txt"), "utf8"), "lower\n");
      assert.equal(await fs.readFile(path.join(managed, "Case-a.txt"), "utf8"), "upper\n");
    }

    const outsideFiles = await fs.mkdtemp(path.join(os.tmpdir(), "aether-outside-files-"));
    await linkDirectory(outsideFiles, path.join(managed, "linked"));
    await assert.rejects(() => files.createFile("linked/escape.txt"), /链接/);
    await assert.rejects(() => files.trash("linked"), /链接/);
    await assert.rejects(() => files.rename("linked", "linked2"), /链接/);
    assert.equal(await fs.stat(path.join(outsideFiles, "escape.txt")).catch(() => null), null);

    await fs.writeFile(path.join(managed, "src/main.cpp"), "// external\n");
    await assert.rejects(() => files.write("src/main.cpp", "local\n", "stale"), /再次改变/);
    assert.equal(await fs.readFile(path.join(managed, "src/main.cpp"), "utf8"), "// external\n");
    await files.write("src/main.cpp", "// local\n", "// external\n");
    assert.equal(await fs.readFile(path.join(managed, "src/main.cpp"), "utf8"), "// local\n");

    await fs.writeFile(path.join(managed, "external.txt"), "added\n");
    listing = await files.listing();
    assert.equal(listing.files["external.txt"], "added\n", "external addition is listed");
    await fs.rm(path.join(managed, "重命名 目录/新 名字.md"));
    listing = await files.listing();
    assert.equal(Object.hasOwn(listing.files, "重命名 目录/新 名字.md"), false, "external deletion is visible");

    await files.trash("external.txt");
    assert.equal(await fs.stat(path.join(managed, "external.txt")).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(bin, "external.txt"), "utf8"), "added\n", "trash moves the file and keeps it recoverable");
    assert.ok(trashed.some((target) => target.endsWith("external.txt")));
    await files.trash("src/nested");
    assert.ok(await fs.stat(path.join(bin, "src/nested")).catch(() => null));
    await files.reload();
    listing = await files.listing();
    assert.ok(!listing.directories.includes("src/nested"));
    assert.equal(Object.hasOwn(listing.files, "external.txt"), false);
    console.log("PASS files: real disk create/rename/trash, empty directories after reopen, Chinese and space paths, same-name refusal, out-of-bounds/cache/link refusal, per-file write guard, external add/delete visibility, recoverable trash");
  } finally {
    await files.close();
    await fs.rm(managed, { recursive: true, force: true });
    await fs.rm(bin, { recursive: true, force: true });
  }

  const build = await waitTask((await tasks.start("platformio.build")).id);
  assert.equal(build.status, "succeeded", build.log + "\n" + build.error);
  assert.ok(build.toolVersion?.includes("PlatformIO")); assert.ok(build.artifacts.some((artifact) => artifact.path.endsWith("/program") || artifact.path.endsWith("/program.exe")));
  assert.ok(build.artifacts.every((artifact) => artifact.sha256.length === 64 && artifact.size > 0));
  const program = build.artifacts.find((artifact) => /\/program(\.exe)?$/.test(artifact.path))!;
  assert.match((await promisify(execFile)(path.join(directory, program.path))).stdout, /Aether native toolchain smoke/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, ".aether/build.json"), "utf8")).inputHash, build.inputHash);
  const changed = await workspace.reload(); changed.context.files["src/main.cpp"] = "invalid C++ syntax !\n"; await workspace.save(changed.context);
  const failed = await waitTask((await tasks.start("platformio.build")).id);
  assert.equal(failed.status, "failed"); assert.notEqual(failed.exitCode, 0); assert.equal(failed.artifacts.length, 0);
  tasks.register({ id: "fixture.cancel", executable: process.execPath, args: ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('child tree started');setInterval(()=>{},1000)"], artifacts: async () => [] });
  const pending = await tasks.start("fixture.cancel");
  for (let n = 0; n < 100 && !tasks.list().find((task) => task.id === pending.id)!.log.includes("child tree started"); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  await tasks.cancel(pending.id); assert.equal(tasks.list().find((task) => task.id === pending.id)!.status, "cancelled");
  console.log("PASS host: actual folder save/reopen, external edit conflict, symlink boundary, real PlatformIO native compile and executable output, compiler failure, artifact hashes and child-process-tree cancellation");

} finally { await tasks.stopAll(); await workspace.close(); await fs.rm(directory, { recursive: true, force: true }); }
