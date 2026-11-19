// Bounded, read-only reading of a finished PlatformIO log.
// The raw task log stays the source of truth: this module only maps lines whose path it can
// prove belongs to a currently loaded project text file, and it never reads disk, saves a
// buffer, or runs a command quoted by the log.
import type { Range } from "../../shared/language";

export type BuildDiagnosticSeverity = "fatal error" | "error" | "warning";

export interface BuildDiagnostic {
  /** Stable identity for React keys and duplicate suppression. */
  key: string;
  /** Canonical project-relative path; exactly one of the loaded text file keys. */
  file: string;
  /** 1-based line, as printed by the compiler. */
  line: number;
  /** 1-based column, as printed by the compiler; a path without a column defaults to 1. */
  column: number;
  severity: BuildDiagnosticSeverity;
  message: string;
  /** Original log line with ANSI intact; the log itself is never rewritten. */
  raw: string;
}

export interface BuildDiagnosticOptions {
  /** Task root, used to prove that an absolute path sits inside the project. */
  root: string | null;
  /** Currently loaded project text files, keyed by project-relative path. */
  files: Record<string, string>;
  /** Inspect at most this many trailing log lines. */
  maxLines?: number;
  /** Return at most this many diagnostics. */
  maxEntries?: number;
}

export interface BuildDiagnosticSnapshot {
  diagnostics: BuildDiagnostic[];
  /** Number of trailing log lines actually inspected. */
  scannedLines: number;
  /** True when older log lines were outside the inspected window. */
  truncated: boolean;
}

export const BUILD_DIAGNOSTIC_LIMITS = { lines: 4000, entries: 50, message: 320 } as const;

export interface DiagnosticTarget { file: string; range: Range }

// Compilers colorize `error:` and the path; strip escapes for matching only.
const ANSI_SEQUENCE = /(?:\u001B\[[0-?]*[ -/]*[@-~])|(?:\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
// GCC and Clang print `file:line[:column]: error|warning|fatal error: message`.
const SEVERITY_MARKER = /: (fatal error|error|warning): /;
// Lazy path with an anchored tail so `file:12:5` keeps its column instead of folding it into the line.
const LOCATION_TAIL = /^(.*?):(\d{1,7})(?::(\d{1,7}))?$/;
// Only project source text is clickable; `platformio.ini`, `circuit.json` and build output are not.
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|ino)$/i;

const own = (files: Record<string, string>, key: string) => Object.prototype.hasOwnProperty.call(files, key);

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

const stripAnsi = (line: string) => line.replace(ANSI_SEQUENCE, "");

interface ParsedPath { kind: "absolute" | "relative"; absoluteKind?: "drive" | "unc" | "posix"; segments: string[] }

/** Splits a printed path into segments, rejecting everything that is not canonical. */
function parsePrintedPath(value: string): ParsedPath | null {
  let text = value.trim();
  if (!text) return null;
  // A printed root may carry a trailing separator; that alone is not a different directory.
  if (/^[A-Za-z]:[\\/]/.test(text) || /^[\\/]/.test(text)) text = text.replace(/[\\/]+$/, "");
  if (!text) return null;
  const drive = /^([A-Za-z]):[\\/]/.exec(text);
  if (drive) {
    const segments = splitPathSegments(text.slice(2).replace(/^[\\/]+/, ""));
    if (!segments) return null;
    return { kind: "absolute", absoluteKind: "drive", segments: [drive[1].toUpperCase() + ":", ...segments] };
  }
  const unc = /^[\\/]{2}([^\\/]+)/.exec(text);
  if (unc) {
    const segments = splitPathSegments(text.replace(/^[\\/]+/, ""));
    if (!segments || segments.length < 2) return null;
    return { kind: "absolute", absoluteKind: "unc", segments };
  }
  if (text.startsWith("/") || text.startsWith("\\")) {
    const segments = splitPathSegments(text.replace(/^[\\/]+/, ""));
    if (!segments) return null;
    return { kind: "absolute", absoluteKind: "posix", segments };
  }
  // `name:...` is a URI scheme or a drive-relative path: neither is a project file.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return null;
  const segments = splitPathSegments(text);
  if (!segments) return null;
  return { kind: "relative", segments };
}

/** Splits on single separators: doubled separators are not canonical and would hide an empty segment. */
function splitPathSegments(body: string): string[] | null {
  if (!body || /[\\/]{2}/.test(body)) return null;
  const segments = body.split(/[\\/]/);
  return canonicalSegments(segments) ? segments : null;
}

function canonicalSegments(segments: string[]): boolean {
  return segments.every((segment) => {
    if (!segment || segment === "." || segment === "..") return false;
    // Virtual schemes and colon-adorned names are not project files on any supported host.
    return !segment.includes(":");
  });
}

/**
 * Maps a printed path to a project-relative path.
 * Relative paths are already project-relative; absolute paths must share every root segment
 * (so `C:\work\demo-evil` never matches root `C:\work\demo`). Traversal, UNC or URI paths
 * outside the root, and mismatched absolute styles are rejected rather than guessed.
 */
function projectRelativePath(rawPath: string, root: string | null): string | null {
  const parsed = parsePrintedPath(rawPath);
  if (!parsed) return null;
  if (parsed.kind === "relative") return parsed.segments.join("/");
  if (!root) return null;
  const parsedRoot = parsePrintedPath(root);
  if (!parsedRoot || parsedRoot.kind !== "absolute" || parsedRoot.absoluteKind !== parsed.absoluteKind) return null;
  if (parsed.segments.length <= parsedRoot.segments.length) return null;
  const fold = parsed.absoluteKind === "posix" ? (segment: string) => segment : (segment: string) => segment.toLowerCase();
  for (let index = 0; index < parsedRoot.segments.length; index++) {
    if (fold(parsed.segments[index]) !== fold(parsedRoot.segments[index])) return null;
  }
  return parsed.segments.slice(parsedRoot.segments.length).join("/");
}

/** Exact loaded key first; a Windows-style path may differ only by case, and only when unambiguous. */
function loadedFile(relative: string, files: Record<string, string>, caseInsensitive: boolean): string | null {
  if (own(files, relative)) return relative;
  if (!caseInsensitive) return null;
  const folded = relative.toLowerCase();
  const matches = Object.keys(files).filter((key) => key.toLowerCase() === folded);
  return matches.length === 1 ? matches[0] : null;
}

function resolvePrintedFile(rawPath: string, root: string | null, files: Record<string, string>): string | null {
  const parsed = parsePrintedPath(rawPath);
  if (!parsed) return null;
  const relative = projectRelativePath(rawPath, root);
  if (!relative || !SOURCE_FILE.test(relative)) return null;
  const caseInsensitive = parsed.kind === "absolute" && parsed.absoluteKind !== "posix";
  return loadedFile(relative, files, caseInsensitive);
}

/** Compares an open project root with the root a task was started under. */
export function sameProjectRoot(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const a = parsePrintedPath(left);
  const b = parsePrintedPath(right);
  if (!a || !b || a.kind !== "absolute" || b.kind !== "absolute" || a.absoluteKind !== b.absoluteKind) return left === right;
  if (a.segments.length !== b.segments.length) return false;
  const fold = a.absoluteKind === "posix" ? (segment: string) => segment : (segment: string) => segment.toLowerCase();
  return a.segments.every((segment, index) => fold(segment) === fold(b.segments[index]));
}

interface ParsedLine { path: string; line: number; column: number; severity: BuildDiagnosticSeverity; message: string }

function parseDiagnosticLine(raw: string): ParsedLine | null {
  const text = stripAnsi(raw);
  if (!text.trim()) return null;
  // Indented text is quoted context, not a compiler diagnostic line.
  if (/^\s/.test(text)) return null;
  const marker = SEVERITY_MARKER.exec(text);
  if (!marker || marker.index <= 0) return null;
  const location = LOCATION_TAIL.exec(text.slice(0, marker.index));
  if (!location || !location[1].trim()) return null;
  const line = Number(location[2]);
  const column = location[3] === undefined ? 1 : Number(location[3]);
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) return null;
  return {
    path: location[1], line, column,
    severity: marker[1] as BuildDiagnosticSeverity,
    message: text.slice(marker.index + marker[0].length).trim(),
  };
}

/**
 * Reads one finished task log. Only the trailing `maxLines` lines are inspected so a huge log
 * cannot turn the panel into an unbounded scan; `truncated` reports that window.
 */
export function collectBuildDiagnostics(log: string, options: BuildDiagnosticOptions): BuildDiagnosticSnapshot {
  const maxLines = clamp(options.maxLines ?? BUILD_DIAGNOSTIC_LIMITS.lines, 1, 20000);
  const maxEntries = clamp(options.maxEntries ?? BUILD_DIAGNOSTIC_LIMITS.entries, 1, 500);
  const lines = log.split(/\r\n|\n/);
  const start = Math.max(0, lines.length - maxLines);
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  for (let index = start; index < lines.length; index++) {
    const raw = lines[index];
    const parsed = parseDiagnosticLine(raw);
    if (!parsed) continue;
    const file = resolvePrintedFile(parsed.path, options.root, options.files);
    if (!file) continue;
    const message = parsed.message.length > BUILD_DIAGNOSTIC_LIMITS.message
      ? parsed.message.slice(0, BUILD_DIAGNOSTIC_LIMITS.message) + "…"
      : parsed.message;
    const key = [file, parsed.line, parsed.column, parsed.severity, message].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ key, file, line: parsed.line, column: parsed.column, severity: parsed.severity, message, raw });
    if (diagnostics.length >= maxEntries) break;
  }
  return { diagnostics, scannedLines: lines.length - start, truncated: start > 0 };
}

/** True when the task still belongs to the open project, so its log is not stale. */
export function isCurrentTask(taskRoot: string | null | undefined, currentRoot: string | null | undefined): boolean {
  return sameProjectRoot(taskRoot, currentRoot);
}

/**
 * Converts an already-resolved diagnostic into the existing editor jump payload.
 * No disk access and no buffer save: the file must still be loaded, its root must still be open,
 * and the 1-based compiler position becomes Monaco's 0-based range.
 */
export function diagnosticTarget(
  diagnostic: BuildDiagnostic,
  context: { taskRoot: string | null | undefined; currentRoot: string | null | undefined; files: Record<string, string> },
): DiagnosticTarget | null {
  if (!sameProjectRoot(context.taskRoot, context.currentRoot)) return null;
  if (!SOURCE_FILE.test(diagnostic.file) || !own(context.files, diagnostic.file)) return null;
  const position = { line: diagnostic.line - 1, character: diagnostic.column - 1 };
  return { file: diagnostic.file, range: { start: { ...position }, end: { ...position } } };
}
