// Shared tool settings contract between the desktop host, preload bridge and plugin UI.
// Only a single executable path is stored; a tool is never assembled into a shell command.
export type ToolSource = "setting" | "environment" | "path";

export interface ToolStatus {
  id: string;
  name: string;
  env: string;
  description: string;
  /** User-configured value exactly as saved in the application data directory. */
  configured: string;
  /** Executable handed to spawn() for this tool, resolved from setting → environment → PATH. */
  executable: string;
  source: ToolSource;
  available: boolean;
  /** Output of the tool's --version probe, when it was actually run. */
  version: string;
  error: string;
  checkedAt: string;
}

export interface ToolsAPI {
  list: () => Promise<ToolStatus[]>;
  status: (id: string) => Promise<ToolStatus>;
  setPath: (id: string, value: string) => Promise<ToolStatus>;
  pick: (id: string) => Promise<string | null>;
  onChanged: (listener: (tools: ToolStatus[]) => void) => () => void;
}
