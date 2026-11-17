import type { ProjectContext } from "../src/plugins/api";
export interface DiskWorkspace { root: string; context: ProjectContext }
export interface BuildArtifact { path: string; sha256: string; size: number }
export interface TaskSnapshot {
  id: string; provider: string; root: string; status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string; endedAt?: string; exitCode: number | null; log: string; error?: string;
  inputHash: string; toolVersion?: string; artifacts: BuildArtifact[];
}
export interface DesktopAPI {
  language: import("./language").LanguageAPI;
  runtime: "electron";
  window: (action: "close" | "minimize" | "maximize") => Promise<void>;
  files: { export: (name: string, content: string) => Promise<string | null>; import: () => Promise<string | null> };
  workspace: {
    open: () => Promise<DiskWorkspace | null>; saveAs: (context: ProjectContext) => Promise<DiskWorkspace | null>;
    save: (context: ProjectContext) => Promise<void>; reload: () => Promise<DiskWorkspace>;
    setDirty: (dirty: boolean) => Promise<void>; close: () => Promise<void>; restore: () => Promise<DiskWorkspace | null>;
    onChanged: (listener: (root: string) => void) => () => void;
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
