import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { SerialLogSaveRequest, SerialLogSaveResult } from "../shared/desktop";

// Native serial diagnostic export. The renderer supplies bounded text, the host asks the native
// save picker for one new path and refuses to overwrite anything already on disk.
export const SERIAL_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_NAME = "aether-serial-log.txt";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function serialLogSuggestedName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || /[\\/\x00-\x1f]/.test(name)) return DEFAULT_NAME;
  const base = name.slice(0, 120) || DEFAULT_NAME;
  return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : base + ".txt";
}

export type SerialLogPick = (suggestedName: string) => Promise<string | null>;

export class SerialLogExportService {
  private generation = 0;
  private pending = false;

  /** A session replacement, session end or project switch makes a picker that is already open stale. */
  invalidate() { this.generation++; }

  async save(request: SerialLogSaveRequest, pick: SerialLogPick): Promise<SerialLogSaveResult> {
    if (this.pending) return { status: "failed", error: "已有导出选择框正在打开" };
    const text = typeof request?.text === "string" ? request.text : "";
    if (!text) return { status: "failed", error: "日志内容为空，未导出" };
    if (Buffer.byteLength(text, "utf8") > SERIAL_LOG_MAX_BYTES) return { status: "failed", error: "日志超过 " + SERIAL_LOG_MAX_BYTES / 1024 / 1024 + " MB 上限，未导出" };

    const generation = this.generation;
    this.pending = true;
    let target: string | null = null;
    try { target = await pick(serialLogSuggestedName(request?.suggestedName)); }
    catch (error) { return { status: "failed", error: "无法打开保存对话框：" + message(error) }; }
    finally { this.pending = false; }

    if (this.generation !== generation) return { status: "cancelled", reason: "invalidated" };
    if (!target) return { status: "cancelled", reason: "picker" };

    // Exclusive create: the dialog-issued path is the only target, and an existing file is never truncated.
    let handle: FileHandle;
    try { handle = await fs.open(target, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "failed", error: "目标文件已存在，未覆盖" };
      return { status: "failed", error: "无法创建文件：" + message(error) };
    }
    try {
      await handle.writeFile(text, "utf8");
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      // Remove only the partial file this call created; the user's existing files are untouched.
      await fs.unlink(target).catch(() => {});
      return { status: "failed", error: "写入失败：" + message(error) };
    }
    return { status: "saved", path: target };
  }
}
