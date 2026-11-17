import type { TerminalProvider } from "../terminal";
export const shellProvider: TerminalProvider = {
  id: "system-shell",
  executable: process.env.AETHER_SHELL || (process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/bash"),
  args: process.platform === "win32" ? [] : ["-i"],
};
