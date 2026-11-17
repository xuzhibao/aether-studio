import { create } from "zustand";
import type { LanguageSnapshot, Range } from "../../shared/language";
const queryDriverKey = "aether.clangd.queryDriver";
// Preference only: a stored opt-in enables clangd's --query-driver, and any storage failure just keeps it off.
const storedQueryDriver = () => { try { return localStorage.getItem(queryDriverKey) === "true"; } catch { return false; } };
export const useLanguage = create<{ snapshot: LanguageSnapshot | null; error: string; jump: { file: string; range: Range } | null; queryDriver: boolean; setQueryDriver: (value: boolean) => void }>((set) => ({
  snapshot: null, error: "", jump: null, queryDriver: storedQueryDriver(),
  setQueryDriver: (value) => { try { localStorage.setItem(queryDriverKey, String(value)); } catch { /* keep the in-memory choice */ } set({ queryDriver: value }); },
}));
