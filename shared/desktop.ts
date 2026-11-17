import type { ProjectContext } from "../src/plugins/api";
import type { ToolsAPI } from "./tools";
export interface DiskWorkspace { root: string; context: ProjectContext; directories: string[] }
export interface DiskListing { files: Record<string, string>; directories: string[] }
/** One unsaved editing session, stored outside the project folder while the user keeps working. */
export interface RecoveryDraft {
  version: 1;
  root: string;
  /** Monotonic content revision; saving or discarding only clears the revision it actually processed. */
  revision: number;
  updatedAt: string;
  context: ProjectContext;
  /** Disk text this draft was based on; a later disk change stays visible as a per-file conflict. */
  disk?: Record<string, string>;
  /** Host-managed files (circuit view and project manifest) as they were when the draft was written. */
  host?: { circuit?: string; manifest?: string };
  openTabs: string[];
  activeTab: string;
}
export interface RecoverySummary {
  root: string; projectName: string; revision: number; updatedAt: string;
  fileCount: number; size: number; openTabs: string[]; activeTab: string; rootExists: boolean; error: string;
}
export interface RecoveryAPI {
  save: (draft: RecoveryDraft) => Promise<void>;
  list: () => Promise<RecoverySummary[]>;
  read: (root: string) => Promise<RecoveryDraft>;
  /** Deletes only when the stored draft is not newer than the revision that was saved or discarded. */
  clear: (root: string, revision: number) => Promise<boolean>;
  /** Explicit user discard, including drafts whose JSON is unreadable. Never touches project files. */
  discard: (root: string) => Promise<boolean>;
}
export interface WorkspaceFileOptions {
  listing: () => Promise<DiskListing>;
  createFile: (path: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  trash: (path: string) => Promise<void>;
  write: (path: string, text: string, expected: string | null) => Promise<void>;
  accept: (path: string) => Promise<void>;
}
export interface BuildArtifact { path: string; sha256: string; size: number }
export interface TaskSnapshot {
  id: string; provider: string; root: string; status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string; endedAt?: string; exitCode: number | null; log: string; error?: string;
  inputHash: string; toolVersion?: string; artifacts: BuildArtifact[];
}
export interface DesktopAPI {
  terminal: import("./terminal").TerminalAPI;
  tools: ToolsAPI;
  language: import("./language").LanguageAPI;
  runtime: "electron";
  window: (action: "close" | "minimize" | "maximize") => Promise<void>;
  files: { export: (name: string, content: string) => Promise<string | null>; import: () => Promise<string | null> };
  recovery: RecoveryAPI;
  workspace: {
    open: () => Promise<DiskWorkspace | null>; saveAs: (context: ProjectContext) => Promise<DiskWorkspace | null>;
    save: (context: ProjectContext) => Promise<void>; reload: () => Promise<DiskWorkspace>;
    setDirty: (dirty: boolean) => Promise<void>; close: () => Promise<void>; restore: () => Promise<DiskWorkspace | null>;
    onChanged: (listener: (root: string) => void) => () => void;
    files: WorkspaceFileOptions;
  };
  tasks: {
    start: (provider: string, options?: Record<string, string>) => Promise<TaskSnapshot>; cancel: (id: string) => Promise<void>;
    list: () => Promise<TaskSnapshot[]>; onChanged: (listener: (task: TaskSnapshot) => void) => () => void;
  };
  serial: {
    list: () => Promise<{ path: string; label: string }[]>; open: (path: string, baudRate: number) => Promise<number>;
    read: (id: number) => Promise<number[]>; write: (id: number, bytes: number[]) => Promise<void>; close: (id: number) => Promise<void>;
  };
}
