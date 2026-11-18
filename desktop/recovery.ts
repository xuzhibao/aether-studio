import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RecoveryDraft, RecoverySummary } from "../shared/desktop";

// Drafts live beside the application state, never inside the project folder and never in a database.
// One directory per project root keeps unrelated projects isolated even when a draft file is damaged.
const draftName = "draft.json";
const rootName = "root.txt";
const maxDraftBytes = 16 * 1024 * 1024;
const absent = (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; };

const keyFor = (root: string) => createHash("sha256").update(root).digest("hex").slice(0, 40);
const assertRoot = (root: string) => {
  if (typeof root !== "string" || !root.trim() || !path.isAbsolute(root) || root.includes("\0")) throw new Error("恢复草稿的工程路径必须是绝对路径");
};
const assertRevision = (revision: number) => {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("恢复草稿版本号无效");
};
const checkDraft = (draft: RecoveryDraft) => {
  if (!draft || draft.version !== 1) throw new Error("不支持的恢复草稿格式");
  assertRoot(draft.root); assertRevision(draft.revision);
  if (!draft.context || typeof draft.context !== "object") throw new Error("恢复草稿缺少工程内容");
  const { project, files, components, wires, capabilities } = draft.context;
  if (!project || typeof project !== "object") throw new Error("恢复草稿缺少工程信息");
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("恢复草稿的文件列表无效");
  for (const [name, text] of Object.entries(files)) if (typeof name !== "string" || typeof text !== "string") throw new Error("恢复草稿只能保存文本文件");
  if (!Array.isArray(components) || !Array.isArray(wires) || !capabilities || typeof capabilities !== "object") throw new Error("恢复草稿的电路内容无效");
  if (draft.disk !== undefined) {
    if (!draft.disk || typeof draft.disk !== "object" || Array.isArray(draft.disk)) throw new Error("恢复草稿的磁盘快照无效");
    for (const [name, text] of Object.entries(draft.disk)) if (typeof name !== "string" || typeof text !== "string") throw new Error("恢复草稿的磁盘快照只能保存文本");
  }
  if (draft.host !== undefined) {
    if (!draft.host || typeof draft.host !== "object" || Array.isArray(draft.host)) throw new Error("恢复草稿的宿主文件快照无效");
    for (const [name, text] of Object.entries(draft.host)) if (!["circuit", "manifest"].includes(name) || typeof text !== "string") throw new Error("恢复草稿的宿主文件快照只能保存电路与工程元数据");
  }
  if (!Array.isArray(draft.openTabs) || typeof draft.activeTab !== "string") throw new Error("恢复草稿的标签页信息无效");
};
const summaryOf = (draft: RecoveryDraft, root: string, size: number, rootExists: boolean): RecoverySummary => ({
  root, projectName: draft.context.project.name || path.basename(root), revision: draft.revision, updatedAt: draft.updatedAt,
  fileCount: Object.keys(draft.context.files).length, size, openTabs: draft.openTabs, activeTab: draft.activeTab, rootExists, error: "",
});

export class RecoveryService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: () => string) {}
  /** Writes and deletes for one root are serialized so a late older revision cannot win a rename race. */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private dirFor(root: string) { assertRoot(root); return path.join(this.directory(), keyFor(root)); }
  private async writeAtomic(target: string, text: string) {
    const temporary = target + "." + process.pid + "." + randomUUID() + ".tmp";
    await fs.writeFile(temporary, text, { flag: "wx" });
    await fs.rename(temporary, target);
  }
  private async readFile(root: string) {
    const dir = this.dirFor(root);
    const text = await fs.readFile(path.join(dir, draftName), "utf8").catch(absent);
    return text === null ? null : { dir, text };
  }
  save(draft: RecoveryDraft) { return this.run(() => this.saveNow(draft)); }
  private async saveNow(draft: RecoveryDraft) {
    checkDraft(draft);
    const dir = this.dirFor(draft.root);
    const text = JSON.stringify({ ...draft, updatedAt: new Date().toISOString() });
    if (Buffer.byteLength(text) > maxDraftBytes) throw new Error("未保存内容超过 16 MB，未写入恢复草稿；请先保存工程");
    await fs.mkdir(dir, { recursive: true });
    const existing = await this.readFile(draft.root);
    if (existing) {
      let stored: RecoveryDraft;
      try { stored = JSON.parse(existing.text) as RecoveryDraft; checkDraft(stored); }
      catch (error) {
        // Never replace bytes we cannot read: the damaged draft may still be recoverable by hand.
        throw new Error("未写入恢复草稿：已有草稿已损坏，未覆盖。请先在恢复窗口丢弃此草稿，或手动备份后处理：" + path.join(dir, draftName) + "（" + (error instanceof Error ? error.message : String(error)) + "）");
      }
      // A late write from an older editing session must not replace newer content.
      if (Number.isSafeInteger(stored.revision) && stored.revision > draft.revision) return;
    }
    await this.writeAtomic(path.join(dir, rootName), draft.root);
    await this.writeAtomic(path.join(dir, draftName), text);
  }
  async read(root: string) {
    const file = await this.readFile(root);
    if (!file) throw new Error("没有找到此工程的恢复草稿：" + root);
    let draft: RecoveryDraft;
    try { draft = JSON.parse(file.text) as RecoveryDraft; checkDraft(draft); }
    catch (error) {
      throw new Error("恢复草稿已损坏，未读取任何内容，工程文件未被修改：" + path.join(file.dir, draftName) + "（" + (error instanceof Error ? error.message : String(error)) + "）");
    }
    if (draft.root !== root) throw new Error("恢复草稿的工程路径不匹配，已拒绝读取：" + path.join(file.dir, draftName));
    return draft;
  }
  async list(): Promise<RecoverySummary[]> {
    const directory = this.directory();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(absent);
    if (!entries) return [];
    const result: RecoverySummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(directory, entry.name);
      const root = (await fs.readFile(path.join(dir, rootName), "utf8").catch(absent))?.trim();
      if (!root || !path.isAbsolute(root)) continue;
      const rootExists = !!(await fs.stat(root).catch(() => null));
      const text = await fs.readFile(path.join(dir, draftName), "utf8").catch(absent);
      if (text === null) continue;
      const size = Buffer.byteLength(text);
      try {
        const draft = JSON.parse(text) as RecoveryDraft; checkDraft(draft);
        if (draft.root !== root) throw new Error("草稿内记录的工程路径与索引不一致");
        result.push(summaryOf(draft, root, size, rootExists));
      } catch (error) {
        result.push({ root, projectName: path.basename(root), revision: 0, updatedAt: "", fileCount: 0, size, openTabs: [], activeTab: "", rootExists, error: "恢复草稿已损坏：" + (error instanceof Error ? error.message : String(error)) + "。工程文件未被修改，可丢弃此草稿。" });
      }
    }
    return result.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }
  private async remove(root: string) {
    const dir = this.dirFor(root);
    await fs.unlink(path.join(dir, draftName)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await fs.unlink(path.join(dir, rootName)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    // Only the now-empty per-root recovery directory is removed; the project folder is never touched.
    await fs.rmdir(dir).catch((error: NodeJS.ErrnoException) => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error; });
  }
  clear(root: string, revision: number) { return this.run(() => this.clearNow(root, revision)); }
  private async clearNow(root: string, revision: number) {
    assertRoot(root); assertRevision(revision);
    const file = await this.readFile(root);
    if (!file) return false;
    let stored: RecoveryDraft | null = null;
    try { stored = JSON.parse(file.text) as RecoveryDraft; } catch { return false; }
    if (!stored || !Number.isSafeInteger(stored.revision) || stored.revision > revision) return false;
    await this.remove(root);
    return true;
  }
  discard(root: string) { return this.run(() => this.discardNow(root)); }
  private async discardNow(root: string) {
    assertRoot(root);
    const file = await this.readFile(root);
    if (!file) return false;
    await this.remove(root);
    return true;
  }
}
