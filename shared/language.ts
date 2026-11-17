import type { CompletionItem, CompletionList, Diagnostic, Hover, Position, Range } from "vscode-languageserver-protocol";
export type { CompletionItem, CompletionList, Diagnostic, Hover, Position, Range };
export type LanguageRequest = "completion" | "hover" | "definition";
export type CompileDatabaseState = "missing" | "ready" | "stale";
export interface DefinitionTarget { file: string; uri: string; range: Range }
export interface LanguageDocument { file: string; version: number; diagnostics: Diagnostic[] }
export interface LanguageStartOptions {
  // PlatformIO environment whose compilation database clangd may use; fixed for the lifetime of the process.
  environment?: string;
  // Explicit opt-in: clangd may run the compiler paths resolved from the selected PlatformIO environment.
  queryDriver?: boolean;
}
export interface LanguageSnapshot {
  id: number; provider: string; root: string; executable: string; environment: string; status: "starting" | "ready" | "stopped" | "error";
  compileDatabase: CompileDatabaseState; compileDatabaseMessage: string; queryDrivers: string[]; args: string[];
  error: string; log: string; documents: LanguageDocument[];
}
export interface LanguageAPI {
  start: (provider: string, root: string, options?: LanguageStartOptions) => Promise<LanguageSnapshot>;
  restart: (id: number, options?: LanguageStartOptions) => Promise<LanguageSnapshot>;
  stop: (id: number) => Promise<void>; get: () => Promise<LanguageSnapshot | null>;
  open: (id: number, file: string, text: string, version: number) => Promise<void>;
  change: (id: number, file: string, text: string, version: number) => Promise<void>;
  close: (id: number, file: string) => Promise<void>;
  request: (id: number, file: string, version: number, method: LanguageRequest, position: Position) => Promise<CompletionItem[] | CompletionList | Hover | DefinitionTarget[] | null>;
  onChanged: (listener: (snapshot: LanguageSnapshot) => void) => () => void;
}
