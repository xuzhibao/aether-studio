import { create } from "zustand";
import type { LanguageSnapshot, Range } from "../../shared/language";
export const useLanguage = create<{ snapshot: LanguageSnapshot | null; error: string; jump: { file: string; range: Range } | null }>(() => ({ snapshot: null, error: "", jump: null }));
