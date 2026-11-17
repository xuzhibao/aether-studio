import type { CompletionItem, CompletionList, Diagnostic, Hover, Position, Range } from "vscode-languageserver-protocol";
export type { CompletionItem, CompletionList, Diagnostic, Hover, Position, Range };
export type LanguageRequest = "completion" | "hover" | "definition";
export interface DefinitionTarget { file: string; uri: string; range: Range }
export interface LanguageDocument { file: string; version: number; diagnostics: Diagnostic[] }
export interface LanguageSnapshot {
  id: number; provider: string; root: string; status: "starting" | "ready" | "stopped" | "error";
  compileDatabase: boolean; error: string; log: string; documents: LanguageDocument[];
}
export interface LanguageAPI {
  start: (provider: string, root: string) => Promise<LanguageSnapshot>;
  stop: (id: number) => Promise<void>; get: () => Promise<LanguageSnapshot | null>;
  open: (id: number, file: string, text: string, version: number) => Promise<void>;
  change: (id: number, file: string, text: string, version: number) => Promise<void>;
  close: (id: number, file: string) => Promise<void>;
  request: (id: number, file: string, version: number, method: LanguageRequest, position: Position) => Promise<CompletionItem[] | CompletionList | Hover | DefinitionTarget[] | null>;
  onChanged: (listener: (snapshot: LanguageSnapshot) => void) => () => void;
}
