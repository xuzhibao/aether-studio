export interface TerminalSnapshot {
  id: number; provider: string; root: string; shell: string; pid: number;
  status: "running" | "exited" | "stopped"; cols: number; rows: number;
  exitCode: number | null; signal: number | null;
}
export interface TerminalAPI {
  start: (provider: string, root: string, cols: number, rows: number) => Promise<TerminalSnapshot>;
  get: () => Promise<TerminalSnapshot | null>; stop: (id: number) => Promise<void>;
  write: (id: number, data: string) => Promise<void>; read: (id: number) => Promise<string>;
  resize: (id: number, cols: number, rows: number) => Promise<void>;
  onChanged: (listener: (snapshot: TerminalSnapshot) => void) => () => void;
}
