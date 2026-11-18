import assert from "node:assert/strict";

// The stores are browser modules; a small shim provides the persisted-storage and desktop bridge
// they expect. The bridge is a fixed fixture: no real files, ports or devices are touched.
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)); },
  removeItem: (key: string) => { memory.delete(key); },
  clear: () => { memory.clear(); },
  key: () => null,
  length: 0,
} as Storage;

const root = "A:/aether-review-fixture";
const diskFiles: Record<string, string> = {};
let saved = 0;
let written = 0;
let accepted = 0;
const starts: { provider: string; options: Record<string, string> }[] = [];
let sequence = 0;
const recovery = { save: async () => {}, list: async () => [], read: async () => { throw new Error("no draft"); }, clear: async () => true, discard: async () => true };
const bridge = {
  runtime: "electron",
  workspace: {
    open: async () => null, saveAs: async () => null, close: async () => {}, setDirty: async () => {}, restore: async () => null,
    onChanged: () => () => {},
    reload: async () => ({ root, context: null, directories: [] }),
    save: async (context: { files: Record<string, string> }) => {
      saved++;
      for (const [name, text] of Object.entries(context.files)) if (name !== "circuit.json") diskFiles[name] = text;
    },
    files: {
      listing: async () => ({ files: { ...diskFiles }, directories: [] }),
      createFile: async () => {}, createDirectory: async () => {}, rename: async () => {}, trash: async () => {},
      accept: async () => { accepted++; },
      write: async (name: string, text: string, expected: string | null) => {
        const current = Object.hasOwn(diskFiles, name) ? diskFiles[name] : null;
        if (current !== expected) throw new Error("文件内容在预览后已再次改变：" + name);
        diskFiles[name] = text; written++;
      },
    },
  },
  tasks: {
    list: async () => [],
    environments: async () => [{ name: "env-a", default: true }, { name: "env-b", default: false }],
    cancel: async () => {},
    onChanged: () => () => {},
    start: async (provider: string, options: Record<string, string> = {}) => {
      starts.push({ provider, options });
      return {
        id: "task-" + (++sequence), provider, root, environment: options.environment, status: "succeeded",
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0, log: "",
        inputHash: "fixture", artifacts: [], options,
      };
    },
  },
  recovery,
  serial: { list: async () => [], open: async () => 0, read: async () => [], write: async () => {}, close: async () => {} },
  language: { onChanged: () => () => {}, get: async () => null, start: async () => {}, restart: async () => {}, stop: async () => {}, open: async () => {}, change: async () => {}, close: async () => {}, request: async () => null },
  terminal: { onChanged: () => () => {}, get: () => null, start: async () => null, stop: async () => {}, write: async () => {}, read: async () => 0, resize: async () => {} },
  tools: { list: async () => [], status: async () => ({}), setPath: async () => ({}), pick: async () => null, onChanged: () => () => {} },
  files: { export: async () => null, import: async () => null },
  window: async () => {},
};
(globalThis as unknown as { window: unknown }).window = Object.assign(globalThis, { aether: bridge });

const { useDisk, isActionCancelled, acceptReviewedDiskChanges, finishBuildReview, diskChanges } = await import("../src/store/disk");
const { useStudio } = await import("../src/store/studio");
const { useProjectFiles } = await import("../src/plugins/builtin/projectFilesState");

const initial = {
  "platformio.ini": "[env:env-a]\nplatform = espressif32@6.12.0\nboard = board-a\n",
  "partitions.csv": "csv-before\n",
  "src/main.cpp": "int main() { return 0; }\n",
  "notes.txt": "notes before\n",
};
const project = { id: "review", name: "Review fixture", description: "", board: "", template: "", accent: "#007AFF", updated: "Local" };
const capabilities = { board: "", toolchain: "platformio", simulator: "", editor: "monaco" };

function reset() {
  for (const name of Object.keys(diskFiles)) delete diskFiles[name];
  Object.assign(diskFiles, initial);
  useDisk.getState().adopt({ root, context: { project, components: [], wires: [], files: { ...initial }, capabilities }, directories: [] });
  useDisk.setState({ environments: [{ name: "env-a", default: true }, { name: "env-b", default: false }], environment: "env-a", tasks: [], starting: false, error: "" });
  useProjectFiles.getState().close();
  starts.length = 0; saved = 0; written = 0; accepted = 0;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForReview() {
  for (let n = 0; n < 200; n++) {
    const dialog = useProjectFiles.getState().dialog;
    if (dialog?.kind === "changes" && dialog.build) return dialog;
    await sleep(10);
  }
  throw new Error("the pre-build review did not open: " + JSON.stringify(useProjectFiles.getState().dialog));
}
/** The dialog's Continue button: close, then resolve the pending intent. */
function continueReview() { useProjectFiles.getState().close(); finishBuildReview("continue"); }
function cancelReview() { useProjectFiles.getState().close(); finishBuildReview("cancel"); }
const settleError = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Error);

let passed = 0;
const check = (name: string) => { passed++; console.log("  ✓ " + name); };

try {
  // --- Cancel: no save, no task, no upload.
  reset();
  diskFiles["platformio.ini"] += "; external\n";
  const cancelling = useDisk.getState().build("platformio.build");
  void cancelling.catch(() => {});
  await waitForReview();
  assert.equal(starts.length, 0, "no task exists while the review is open");
  assert.throws(() => useDisk.getState().setEnvironment("env-b"), /构建准备中/, "the environment cannot be switched during review");
  cancelReview();
  const cancelled = await settleError(cancelling);
  assert.ok(isActionCancelled(cancelled), String(cancelled));
  assert.match(cancelled!.message, /未创建构建任务/);
  assert.equal(starts.length, 0, "cancel creates no task");
  assert.equal(saved, 0, "cancel writes no project files");
  assert.equal(useDisk.getState().starting, false);
  check("cancel closes the review without saving, starting a task, or flashing");

  // --- Pure external edits: one explicit continue re-reads them and runs the original build.
  reset();
  diskFiles["platformio.ini"] += "; external\n";
  diskFiles["partitions.csv"] = "csv-after\n";
  const continuing = useDisk.getState().build("platformio.build");
  await waitForReview();
  assert.ok(diskChanges().every((item) => !item.dirty), "pure external edits are not conflicts");
  await acceptReviewedDiskChanges();
  continueReview();
  const task = await continuing;
  assert.equal(task.provider, "platformio.build");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.environment, "env-a");
  assert.equal(useStudio.getState().files["partitions.csv"], "csv-after\n", "the buffer follows the disk");
  assert.equal(saved, 1, "the resolved project is saved before the task starts");
  assert.equal(diskFiles["partitions.csv"], "csv-after\n");
  check("one continue re-reads pure external edits and starts the original build");

  // --- A file changed on both sides is a conflict: it needs an explicit choice and other edits survive.
  reset();
  useStudio.getState().updateFile("src/main.cpp", "local main\n");
  useStudio.getState().updateFile("notes.txt", "local notes\n");
  useStudio.getState().moveComponent("board-1", 12, 34);
  diskFiles["src/main.cpp"] = "external main\n";
  const conflict = useDisk.getState().build("platformio.build");
  void conflict.catch(() => {});
  await waitForReview();
  assert.ok(diskChanges().some((item) => item.file === "src/main.cpp" && item.dirty), "the conflicting file is marked");
  await assert.rejects(() => acceptReviewedDiskChanges(), /仍在冲突中/, "continue refuses while a conflict is unresolved");
  assert.equal(starts.length, 0, "an unresolved conflict starts nothing");
  await useDisk.getState().keepLocal("src/main.cpp");
  assert.equal(diskFiles["src/main.cpp"], "local main\n", "the explicit local choice overwrites that file only");
  assert.equal(diskFiles["notes.txt"], "notes before\n", "other files stay untouched until the save");
  await acceptReviewedDiskChanges();
  continueReview();
  await conflict;
  assert.equal(starts.length, 1);
  assert.equal(useStudio.getState().files["notes.txt"], "local notes\n", "other unsaved edits are kept");
  assert.equal(diskFiles["notes.txt"], "local notes\n", "and saved with the project");
  check("conflicts need an explicit per-file choice; unrelated unsaved code is preserved");

  // --- Changing the environment after confirmation cancels instead of silently using another one.
  reset();
  diskFiles["platformio.ini"] += "; external\n";
  const swapping = useDisk.getState().build("platformio.build");
  void swapping.catch(() => {});
  await waitForReview();
  useDisk.setState({ environment: "env-b" });
  continueReview();
  const swapped = await settleError(swapping);
  assert.ok(isActionCancelled(swapped), String(swapped));
  assert.match(swapped!.message, /构建环境在确认后发生变化/);
  assert.equal(starts.length, 0);
  assert.equal(saved, 0);
  check("a changed environment after confirmation cancels with no task");

  // --- The deploy path uses the same review and keeps the captured port.
  reset();
  diskFiles["partitions.csv"] = "csv-deploy\n";
  const deploy = useDisk.getState().build("platformio.upload", { port: "COM9" });
  await waitForReview();
  await acceptReviewedDiskChanges();
  continueReview();
  const upload = await deploy;
  assert.equal(upload.provider, "platformio.upload");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.port, "COM9", "the port chosen before the review is the one used");
  assert.equal(starts[0].options.environment, "env-a");
  check("deploy review keeps the captured port and environment");

  // --- Nothing changed: no dialog, the task starts directly.
  reset();
  const direct = await useDisk.getState().build("platformio.build");
  assert.equal(useProjectFiles.getState().dialog, null, "no review without disk changes");
  assert.equal(direct.provider, "platformio.build");
  assert.equal(starts.length, 1);
  assert.equal(written, 0);
  check("an unchanged project builds directly without a review");

  // --- An external write that exactly matches the buffer has no visible diff, but the host baseline
  //     must advance too; otherwise the whole-project save would still refuse it.
  reset();
  useStudio.setState((state) => ({ files: { ...state.files, "platformio.ini": "identical external write\n" } }));
  diskFiles["platformio.ini"] = "identical external write\n";
  const identical = await useDisk.getState().build("platformio.build");
  assert.equal(useProjectFiles.getState().dialog, null);
  assert.equal(identical.provider, "platformio.build");
  assert.equal(starts.length, 1);
  assert.ok(accepted > 0, "the host baseline was advanced for the matching external write");
  check("a matching external write advances the host baseline without a review");

  console.log("PASS build review: " + passed + " checks; external edits are re-read per file, conflicts need explicit choices, cancel creates no task, and the captured environment/port are never swapped");
} finally {
  useProjectFiles.getState().close();
}
