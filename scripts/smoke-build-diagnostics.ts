import assert from "node:assert/strict";
import {
  BUILD_DIAGNOSTIC_LIMITS, collectBuildDiagnostics, diagnosticTarget, sameProjectRoot,
  type BuildDiagnostic,
} from "../src/lib/buildDiagnostics";

// Focused checks for the read-only PlatformIO compiler diagnostics list.
// No disk, no Electron, no PlatformIO and no hardware: logs are fed as text and the
// expected result is the exact file/line/column the editor would receive.
let passed = 0;
const check = (name: string, run: () => void) => { run(); passed++; console.log("  ✓ " + name); };

const files: Record<string, string> = {
  "src/main.cpp": "void setup() {}\n",
  "src/中文.cpp": "// utf8\n",
  "include/board.h": "#pragma once\n",
  "platformio.ini": "[env:demo]\n",
  "circuit.json": "{}\n",
};
const root = "C:\\work\\demo";
const collect = (log: string, options: Partial<{ root: string | null; files: Record<string, string>; maxLines: number; maxEntries: number }> = {}) =>
  collectBuildDiagnostics(log, { root, files, ...options });
const locations = (log: string, options: Parameters<typeof collect>[1] = {}) =>
  collect(log, options).diagnostics.map((item) => `${item.file}:${item.line}:${item.column}:${item.severity}`);

// --- Parsing and project-relative locations ---------------------------------

check("unix relative path with line and column", () => {
  const result = collect("src/main.cpp:12:5: error: 'x' was not declared in this scope\n");
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic.file, "src/main.cpp");
  assert.equal(diagnostic.line, 12);
  assert.equal(diagnostic.column, 5);
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.message, "'x' was not declared in this scope");
  assert.equal(diagnostic.raw, "src/main.cpp:12:5: error: 'x' was not declared in this scope");
});

check("missing column defaults to 1 and warning severity is kept", () => {
  assert.deepEqual(locations("src/main.cpp:7: warning: unused variable 'y'"), ["src/main.cpp:7:1:warning"]);
});

check("fatal error severity is preserved", () => {
  assert.deepEqual(locations("include/board.h:1:10: fatal error: missing.h: No such file or directory"), ["include/board.h:1:10:fatal error"]);
});

check("windows backslashes in a relative path", () => {
  assert.deepEqual(locations("src\\main.cpp:3:2: error: boom"), ["src/main.cpp:3:2:error"]);
});

check("absolute windows drive path inside the task root (backslashes)", () => {
  assert.deepEqual(locations("C:\\work\\demo\\src\\main.cpp:4:6: error: boom"), ["src/main.cpp:4:6:error"]);
});

check("absolute windows drive path inside the task root (forward slashes)", () => {
  assert.deepEqual(locations("C:/work/demo/src/main.cpp:4:6: error: boom"), ["src/main.cpp:4:6:error"]);
});

check("root and file paths containing spaces", () => {
  assert.deepEqual(locations("C:\\work\\my demo\\src\\main.cpp:2:3: error: boom", { root: "C:\\work\\my demo" }), ["src/main.cpp:2:3:error"]);
});

check("windows path case differs from the loaded key", () => {
  assert.deepEqual(locations("c:\\WORK\\demo\\SRC\\Main.cpp:8:1: error: boom"), ["src/main.cpp:8:1:error"]);
});

check("root with a trailing separator still matches", () => {
  assert.deepEqual(locations("C:\\work\\demo\\src\\main.cpp:1:1: error: boom", { root: "C:\\work\\demo\\" }), ["src/main.cpp:1:1:error"]);
});

check("ANSI color codes are stripped for parsing but the raw line is kept", () => {
  const raw = "\u001b[31mC:\\work\\demo\\src\\main.cpp:9:4: \u001b[31merror: \u001b[0mboom";
  const result = collect(raw);
  assert.deepEqual(result.diagnostics.map((item) => `${item.file}:${item.line}:${item.column}`), ["src/main.cpp:9:4"]);
  assert.equal(result.diagnostics[0].message, "boom");
  assert.equal(result.diagnostics[0].raw, raw);
});

check("UTF-8 paths and messages survive", () => {
  const result = collect("src/中文.cpp:2:1: error: 未声明的标识符");
  assert.equal(result.diagnostics[0].file, "src/中文.cpp");
  assert.equal(result.diagnostics[0].message, "未声明的标识符");
});

check("message with a colon keeps the first severity marker as the separator", () => {
  assert.deepEqual(locations("src/main.cpp:5:2: error: expected ';' after: error: token"), ["src/main.cpp:5:2:error"]);
  assert.equal(collect("src/main.cpp:5:2: error: expected ';' after: error: token").diagnostics[0].message, "expected ';' after: error: token");
});

check("long messages are bounded", () => {
  const message = "x".repeat(BUILD_DIAGNOSTIC_LIMITS.message + 50);
  const result = collect(`src/main.cpp:1:1: error: ${message}`);
  assert.equal(result.diagnostics[0].message.length, BUILD_DIAGNOSTIC_LIMITS.message + 1);
  assert.ok(result.diagnostics[0].message.endsWith("…"));
});

// --- Duplicates and caps ----------------------------------------------------

check("duplicate diagnostics collapse, distinct ones stay", () => {
  const log = [
    "src/main.cpp:1:1: error: same",
    "src/main.cpp:1:1: error: same",
    "src/main.cpp:1:2: error: same",
    "src/main.cpp:1:1: warning: same",
  ].join("\n");
  assert.equal(collect(log).diagnostics.length, 3);
});

check("entries are capped in log order", () => {
  const log = ["src/main.cpp:1:1: error: a", "src/main.cpp:2:1: error: b", "src/main.cpp:3:1: error: c"].join("\n");
  const result = collect(log, { maxEntries: 2 });
  assert.deepEqual(result.diagnostics.map((item) => item.line), [1, 2]);
});

check("window is bounded to the tail of the log and reports truncation", () => {
  const lines = ["src/main.cpp:1:1: error: first"];
  for (let index = 0; index < 20; index++) lines.push(`gcc output line ${index}`);
  lines.push("src/main.cpp:99:1: error: last");
  const all = collect(lines.join("\n"));
  assert.deepEqual(all.diagnostics.map((item) => item.line), [1, 99]);
  assert.equal(all.truncated, false);
  const tailOnly = collect(lines.join("\n"), { maxLines: 5 });
  assert.deepEqual(tailOnly.diagnostics.map((item) => item.line), [99]);
  assert.equal(tailOnly.truncated, true);
  assert.equal(tailOnly.scannedLines, 5);
});

// --- Rejected lines and paths remain raw-log content ------------------------

check("absolute path outside the task root is not actionable", () => {
  assert.deepEqual(locations("C:\\other\\src\\main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("D:\\work\\demo\\src\\main.cpp:1:1: error: boom"), []);
});

check("sibling directory sharing the root prefix is not inside the root", () => {
  assert.deepEqual(locations("C:\\work\\demo-evil\\src\\main.cpp:1:1: error: boom"), []);
});

check("UNC path with a local root is rejected", () => {
  assert.deepEqual(locations("\\\\server\\share\\demo\\src\\main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("//server/share/demo/src/main.cpp:1:1: error: boom"), []);
});

check("traversal and non-canonical separators are rejected", () => {
  assert.deepEqual(locations("../outside/src/main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("src/../main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("src//main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("C:\\work\\demo\\..\\demo\\src\\main.cpp:1:1: error: boom"), []);
});

check("URI and scheme paths are rejected", () => {
  assert.deepEqual(locations("file:///C:/work/demo/src/main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("webpack:///src/main.cpp:1:1: error: boom"), []);
});

check("a basename is never guessed into a loaded file", () => {
  assert.deepEqual(locations("main.cpp:1:1: error: boom"), []);
});

check("files inherited from a prototype are not loaded files", () => {
  const inherited = Object.create({ "src/ghost.cpp": "" }) as Record<string, string>;
  inherited["src/main.cpp"] = "";
  assert.deepEqual(collect("src/ghost.cpp:1:1: error: boom", { files: inherited }).diagnostics, []);
  assert.deepEqual(locations("src/main.cpp:1:1: error: boom", { files: inherited }), ["src/main.cpp:1:1:error"]);
});

check("non-source and virtual paths are rejected even when loaded", () => {
  assert.deepEqual(locations("platformio.ini:3:1: error: boom"), []);
  assert.deepEqual(locations("circuit.json:1:1: error: boom"), []);
  assert.deepEqual(locations("src/main.obj:1:1: error: boom"), []);
});

check("malformed and partial lines are not transformed", () => {
  assert.deepEqual(locations("src/main.cpp:12: error"), []);
  assert.deepEqual(locations("src/main.cpp:0:1: error: boom"), []);
  assert.deepEqual(locations("src/main.cpp:1:0: error: boom"), []);
  assert.deepEqual(locations(" src/main.cpp:1:1: error: boom"), []);
  assert.deepEqual(locations("\tIn file included from src/main.cpp:1:"), []);
  assert.deepEqual(locations("error: linker command failed"), []);
  assert.deepEqual(locations("undefined reference to `foo()'"), []);
});

check("the raw log is never rewritten", () => {
  const log = "src/main.cpp:1:1: error: boom\nC:\\other\\main.cpp:2:1: error: outside\nundefined reference\n";
  collect(log);
  assert.equal(log, "src/main.cpp:1:1: error: boom\nC:\\other\\main.cpp:2:1: error: outside\nundefined reference\n");
});

// --- Jump target: the exact payload the editor consumes ---------------------

const sample = collect("src/main.cpp:12:5: error: boom").diagnostics[0];
check("jump target converts 1-based compiler positions to Monaco 0-based ranges", () => {
  const target = diagnosticTarget(sample, { taskRoot: root, currentRoot: root, files });
  assert.ok(target);
  assert.equal(target.file, "src/main.cpp");
  assert.deepEqual(target.range, { start: { line: 11, character: 4 }, end: { line: 11, character: 4 } });
  // EditorPane reads jump.range.start and appends 1 to both values; that must return the compiler position.
  assert.equal(target.range.start.line + 1, sample.line);
  assert.equal(target.range.start.character + 1, sample.column);
});

check("jump target rejects a stale root", () => {
  assert.equal(diagnosticTarget(sample, { taskRoot: root, currentRoot: "C:\\work\\other", files }), null);
  assert.equal(diagnosticTarget(sample, { taskRoot: root, currentRoot: null, files }), null);
});

check("jump target rejects a deleted or unloaded file", () => {
  assert.equal(diagnosticTarget(sample, { taskRoot: root, currentRoot: root, files: { "src/other.cpp": "" } }), null);
});

check("jump target rejects an inherited file property", () => {
  const inherited = Object.create({ "src/main.cpp": "" }) as Record<string, string>;
  assert.equal(diagnosticTarget(sample, { taskRoot: root, currentRoot: root, files: inherited }), null);
});

check("root comparison is case-insensitive for windows drives and exact for POSIX", () => {
  assert.equal(sameProjectRoot("c:\\WORK\\demo\\", "C:\\work\\demo"), true);
  assert.equal(sameProjectRoot("C:\\work\\demo", "C:\\work\\demo-evil"), false);
  assert.equal(sameProjectRoot("/work/demo", "/work/Demo"), false);
  assert.equal(sameProjectRoot("/work/demo/", "/work/demo"), true);
  assert.equal(sameProjectRoot("C:\\work\\demo", "/work/demo"), false);
  assert.equal(sameProjectRoot(null, root), false);
});

check("a diagnostic not produced by the parser is still validated on click", () => {
  const forged = { ...sample, file: "src/../../etc/passwd" } as BuildDiagnostic;
  assert.equal(diagnosticTarget(forged, { taskRoot: root, currentRoot: root, files }), null);
});

console.log(`PASS build diagnostics: ${passed} focused checks completed`);
