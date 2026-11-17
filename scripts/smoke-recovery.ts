import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecoveryService } from "../desktop/recovery";
import type { RecoveryDraft } from "../shared/desktop";
import type { ProjectContext } from "../src/plugins/api";

// Isolated user-data directory: every draft below is test data, never a user project.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-recovery-"));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aether-recovery-project-"));
const service = new RecoveryService(() => directory);
const root = await fs.realpath(temporary);
const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aether-recovery-other-"));
const files: Record<string, string> = { "src/main.cpp": "int main() { return 0; }\n", "README.md": "草稿测试\n" };
const context = (name: string): ProjectContext => ({
  project: { id: "recovery-smoke", name, description: "", board: "esp32-s3", template: "", accent: "#007AFF", updated: "Local" },
  components: [{ id: "board-1", kind: "board", name: "Board", x: 0, y: 0, pins: [] } as never],
  wires: [],
  files: { ...files, "src/main.cpp": files["src/main.cpp"] + "// " + name + "\n" },
  capabilities: { board: "esp32-s3", toolchain: "platformio", simulator: "", editor: "monaco" },
});
const draft = (revision: number, name = "Recovery smoke", source = root): RecoveryDraft => ({
  version: 1, root: source, revision, updatedAt: new Date().toISOString(), context: context(name), openTabs: ["src/main.cpp", "circuit"], activeTab: "src/main.cpp",
});
const draftText = async (target = root) => {
  const dirs = await fs.readdir(directory);
  for (const entry of dirs) {
    const base = path.join(directory, entry);
    const owner = await fs.readFile(path.join(base, "root.txt"), "utf8").catch(() => null);
    if (owner?.trim() === target) return { dir: base, text: await fs.readFile(path.join(base, "draft.json"), "utf8") };
  }
  return null;
};
const leftovers = async () => {
  const found: string[] = [];
  const walk = async (dir: string) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) entry.isDirectory() ? await walk(path.join(dir, entry.name)) : entry.name.endsWith(".tmp") && found.push(path.join(dir, entry.name)); };
  await walk(directory); return found;
};
try {
  await fs.writeFile(path.join(root, "src/main.cpp"), files["src/main.cpp"]).catch(async () => { await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src/main.cpp"), files["src/main.cpp"]); });
  await fs.writeFile(path.join(root, "README.md"), files["README.md"]);

  await service.save(draft(10));
  let list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].root, root);
  assert.equal(list[0].revision, 10);
  assert.equal(list[0].fileCount, 2);
  assert.equal(list[0].rootExists, true);
  assert.equal(list[0].error, "");
  assert.ok((await draftText())?.text.includes("Recovery smoke"));
  assert.equal((await service.read(root)).context.files["README.md"], "草稿测试\n");

  // A late write from an older revision cannot replace newer content.
  await service.save(draft(11, "Newer"));
  await service.save(draft(10, "Stale"));
  list = await service.list();
  assert.equal(list[0].revision, 11);
  assert.match((await service.read(root)).context.project.name, /Newer/);

  // Processed-version rule: the save that wrote revision 11 must not clear a newer revision.
  await service.save(draft(12, "During save"));
  assert.equal(await service.clear(root, 11), false, "a newer draft survives a save that processed revision 11");
  assert.equal((await service.list())[0].revision, 12);
  assert.equal(await service.clear(root, 12), true);
  assert.equal((await service.list()).length, 0);

  // Root isolation: clearing one project leaves the other draft untouched.
  await fs.mkdir(otherRoot, { recursive: true });
  await service.save(draft(20, "Root A"));
  await service.save(draft(21, "Root B", otherRoot));
  assert.equal((await service.list()).length, 2);
  assert.equal(await service.clear(otherRoot, 21), true);
  list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].root, root);
  assert.equal(await service.clear(root, 20), true);
  assert.deepEqual(await leftovers(), [], "atomic writes leave no temporary files");

  // New edits during save: concurrent saves are serialized and only the newest revision remains.
  await Promise.all([service.save(draft(30, "First")), service.save(draft(31, "Second"))]);
  assert.equal((await service.list())[0].revision, 31);
  assert.equal(await service.clear(root, 30), false);
  assert.equal(await service.clear(root, 31), true);

  // A damaged draft is reported, kept for inspection, and never touches the project source.
  await service.save(draft(40, "Damaged"));
  const stored = await draftText();
  assert.ok(stored);
  await fs.writeFile(path.join(stored!.dir, "draft.json"), "{ this is not json");
  list = await service.list();
  assert.equal(list.length, 1);
  assert.match(list[0].error, /恢复草稿已损坏/);
  await assert.rejects(() => service.read(root), /损坏/);
  assert.equal(await fs.readFile(path.join(root, "src/main.cpp"), "utf8"), files["src/main.cpp"], "project source is untouched by a damaged draft");
  assert.equal(await service.clear(root, 999), false, "an unreadable draft is not silently deleted by a save");
  assert.equal(await service.discard(root), true, "explicit discard removes a damaged draft");
  assert.equal((await service.list()).length, 0);

  // A deleted project directory is reported without blocking the draft.
  await service.save(draft(50, "Deleted root"));
  await fs.rm(root, { recursive: true, force: true });
  list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].rootExists, false);
  assert.equal(await service.discard(root), true);

  // Oversized drafts are refused instead of writing a partial recovery file.
  await service.save(draft(60, "Small"));
  const huge = draft(61, "Huge");
  huge.context.files["big.txt"] = "x".repeat(17 * 1024 * 1024);
  await assert.rejects(() => service.save(huge), /16 MB/);
  assert.equal((await service.list())[0].revision, 60, "refused draft leaves the previous draft intact");
  assert.equal(await service.discard(root), true);

  await assert.rejects(() => service.save({ ...draft(70), root: "relative/path" }), /绝对路径/);
  await assert.rejects(() => service.save({ ...draft(70), revision: -1 }), /版本号/);
  console.log("PASS recovery: per-root atomic drafts, revision-only clearing, newer edits during save, stale-write refusal, damaged-draft isolation, deleted root detection, size refusal, no project writes");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(otherRoot, { recursive: true, force: true });
}
