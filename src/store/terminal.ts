import { create } from "zustand";
import type { TerminalSnapshot } from "../../shared/terminal";
export const useTerminal = create<{ snapshot: TerminalSnapshot | null; error: string }>(() => ({ snapshot: null, error: "" }));
