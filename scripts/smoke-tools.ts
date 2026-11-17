import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolService } from "../desktop/tools";
import { createPlatformioPlugins } from "../desktop/plugins/platformio";
import { createClangdProvider } from "../desktop/plugins/clangd";
import { WorkspaceService } from "../desktop/workspace";
import { TaskService } from "../desktop/tasks";
import { LanguageService } from "../desktop/language";

// Real CLI and LSP fixtures compiled locally. They are test tools, not PlatformIO or clangd.
const cliSourceText = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#define PAUSE() Sleep(1500)
#else
#include <unistd.h>
#define PAUSE() usleep(1500 * 1000)
#endif
#ifndef VERSION
#define VERSION "fixture"
#endif
int main(int argc, char **argv) {
  const char *marker = getenv("AETHER_FIXTURE_MARKER");
  if (marker) {
    FILE *log = fopen(marker, "a");
    if (log) { fprintf(log, "CALL"); for (int i = 1; i < argc; i++) fprintf(log, " [%s]", argv[i]); fputc(10, log); fclose(log); }
  }
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts(VERSION); return 0; }
  printf("ARGV");
  for (int i = 1; i < argc; i++) printf(" [%s]", argv[i]);
  printf("\n");
  fflush(stdout);
  if (argc > 1 && strcmp(argv[1], "project") == 0) { puts("[]"); return 0; }
  if (argc > 1 && strcmp(argv[1], "sleep") == 0) PAUSE();
  return 0;
}
`;

const lspSourceText = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#ifndef VERSION
#define VERSION "lsp-fixture"
#endif
static void reply(const char *body, const char *result) {
  const char *at = strstr(body, "\"id\"");
  char id[64] = "1";
  if (at) {
    at = strchr(at, ':');
    if (at) {
      at++;
      while (*at == ' ') at++;
      const char *end = at;
      while (*end && *end != ',' && *end != '}') end++;
      size_t length = (size_t)(end - at);
      if (length > 0 && length < sizeof id) { memcpy(id, at, length); id[length] = 0; }
    }
  }
  char payload[512];
  int size = snprintf(payload, sizeof payload, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}", id, result);
  printf("Content-Length: %d\r\n\r\n%s", size, payload);
  fflush(stdout);
}
int main(void) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  fprintf(stderr, "FIXTURE_LSP %s\n", VERSION);
  fflush(stderr);
  char line[4096];
  while (fgets(line, sizeof line, stdin)) {
    if (strncmp(line, "Content-Length:", 15) != 0) continue;
    long length = strtol(line + 15, NULL, 10);
    while (fgets(line, sizeof line, stdin)) { if (strcmp(line, "\r\n") == 0 || strcmp(line, "\n") == 0) break; }
    char *body = (char *)calloc((size_t)length + 1, 1);
    size_t got = fread(body, 1, (size_t)length, stdin);
    body[got] = 0;
    if (strstr(body, "\"initialize\"")) reply(body, "{\"capabilities\":{\"positionEncoding\":\"utf-16\"}}");
    else if (strstr(body, "\"shutdown\"")) reply(body, "null");
    free(body);
  }
  return 0;
}
`;

export async function runToolSmoke() {
  const toolTemp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-tools-"));
  const toolBuild = path.join(toolTemp, "build");
  const toolBin = path.join(toolTemp, "工具 fixture 目录");
  await fs.mkdir(toolBuild);
  await fs.mkdir(toolBin);
  const toolFile = () => path.join(toolTemp, "profile", "tools.json");
  const environmentBefore = process.env.AETHER_PLATFORMIO_CLI;
  const compiler = ["gcc", "cc", "clang"].find((name) => { try { execFileSync(name, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } });
  try {
    if (!compiler) {
      console.log("SKIP tool settings: 未找到 C 编译器，无法生成真实 CLI fixture");
      return;
    }
    const cliSource = path.join(toolBuild, "fixture.c");
    const lspSource = path.join(toolBuild, "fixture-lsp.c");
    await fs.writeFile(cliSource, cliSourceText);
    await fs.writeFile(lspSource, lspSourceText);
    const compile = async (source: string, name: string, version: string) => {
      const built = path.join(toolBuild, name);
      execFileSync(compiler, ["-O0", "-o", built, source, `-DVERSION="${version}"`], { stdio: "pipe" });
      const installed = path.join(toolBin, name);
      await fs.copyFile(built, installed);
      await fs.chmod(installed, 0o755).catch(() => {});
      return installed;
    };
    const executableA = await compile(cliSource, "fixture-a.exe", "FixtureTool 1.0.0 (test fixture)");
    const executableB = await compile(cliSource, "fixture-b.exe", "FixtureTool 2.0.0 (test fixture)");
    const lspA = await compile(lspSource, "fixture-clangd-a.exe", "lsp-a");
    const lspB = await compile(lspSource, "fixture-clangd-b.exe", "lsp-b");

    const tools = new ToolService(toolFile);
    const platformio = createPlatformioPlugins(tools);
    createClangdProvider(tools);
    await tools.load();

    // Environment fallback; the saved setting wins. Both paths contain spaces and Chinese.
    process.env.AETHER_PLATFORMIO_CLI = executableA;
    const fromEnvironment = await tools.status("platformio");
    assert.equal(fromEnvironment.source, "environment");
    assert.equal(fromEnvironment.executable, executableA);
    assert.equal(fromEnvironment.available, true, fromEnvironment.error);
    assert.match(fromEnvironment.version, /FixtureTool 1\.0\.0/, "actual --version output from a path with spaces and Chinese");
    await tools.setPath("platformio", executableB);
    const measured = await tools.status("platformio");
    assert.equal(measured.source, "setting");
    assert.equal(measured.configured, executableB);
    assert.match(measured.version, /FixtureTool 2\.0\.0/);
    assert.equal(JSON.parse(await fs.readFile(toolFile(), "utf8")).paths.platformio, executableB);

    // A fresh service models an application restart: the saved path comes back from user data.
    const restored = new ToolService(toolFile);
    createPlatformioPlugins(restored);
    await restored.load();
    assert.equal(restored.configured("platformio"), executableB);
    assert.equal(restored.resolve("platformio").source, "setting");
    assert.equal(restored.executable("platformio"), executableB);
    assert.match((await restored.status("platformio")).version, /FixtureTool 2\.0\.0/);

    // Rejected input is never persisted; a missing file is persisted but reported as unavailable.
    await assert.rejects(() => tools.setPath("platformio", "python -c 'print(1)'"), /单个可执行文件/);
    await assert.rejects(() => tools.setPath("platformio", path.join(toolBin, "tool.bat")), /\.bat/);
    assert.equal(JSON.parse(await fs.readFile(toolFile(), "utf8")).paths.platformio, executableB, "invalid input must not overwrite the saved path");
    const missing = await tools.setPath("platformio", path.join(toolBin, "missing-tool.exe"));
    assert.equal(missing.available, false);
    assert.match(missing.error, /找不到可执行文件/);
    await tools.setPath("platformio", executableB);

    // Build, compiledb and upload each receive the configured executable and arguments.
    const project = path.join(toolTemp, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "platformio.ini"), "[env:fixture]\n");
    const workspace = new WorkspaceService();
    await workspace.open(project);
    const tasks = new TaskService(workspace);
    tasks.register(platformio.platformioBuild);
    tasks.register(platformio.platformioCompileDatabase);
    tasks.register(platformio.platformioUpload);
    const waitTask = async (id: string) => {
      for (let n = 0; n < 400; n++) {
        const task = tasks.list().find((item) => item.id === id)!;
        if (task.status !== "running") return task;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("fixture task timeout");
    };
    const markerFile = path.join(toolTemp, "invocations.txt");
    process.env.AETHER_FIXTURE_MARKER = markerFile;
    const build = await waitTask((await tasks.start("platformio.build")).id);
    assert.ok(build.log.startsWith("$ " + executableB + " run"), build.log);
    assert.match(build.toolVersion ?? "", /FixtureTool 2\.0\.0/);
    const invocations = await fs.readFile(markerFile, "utf8");
    assert.ok(invocations.includes("CALL [run]"), invocations);
    assert.ok(invocations.includes("CALL [project] [config] [--json-output]"), "artifact discovery uses the same executable: " + invocations);
    const compiledb = await waitTask((await tasks.start("platformio.compiledb")).id);
    assert.ok(compiledb.log.startsWith("$ " + executableB + " run --target compiledb"), compiledb.log);
    const upload = await waitTask((await tasks.start("platformio.upload", { port: "COM9" })).id);
    assert.ok(upload.log.startsWith("$ " + executableB + " run --target upload --upload-port COM9"), upload.log);

    // A saved change must not swap the executable of a running task.
    tasks.register({ id: "fixture.slow", executable: () => tools.executable("platformio"), args: ["sleep"], versionArgs: ["--version"], artifacts: async () => ["platformio.ini"] });
    const slow = await tasks.start("fixture.slow");
    for (let n = 0; n < 200 && !tasks.list().find((item) => item.id === slow.id)!.log.includes("ARGV [sleep]"); n++) await new Promise((resolve) => setTimeout(resolve, 20));
    await tools.setPath("platformio", executableA);
    const slowDone = await waitTask(slow.id);
    assert.equal(slowDone.status, "succeeded", slowDone.error);
    assert.ok(slowDone.log.startsWith("$ " + executableB + " sleep"), "running task keeps its executable");
    assert.match(slowDone.toolVersion ?? "", /FixtureTool 2\.0\.0/);
    const next = await waitTask((await tasks.start("platformio.build")).id);
    assert.ok(next.log.startsWith("$ " + executableA + " run"), "the next task uses the saved path");

    // clangd resolves the saved path and restarts with it when the setting changes.
    const languageWorkspace = new WorkspaceService();
    await languageWorkspace.open(project);
    const language = new LanguageService(languageWorkspace);
    language.register(createClangdProvider(tools));
    await tools.setPath("clangd", lspA);
    const session = await language.start("clangd", project);
    assert.equal(session.status, "ready");
    assert.equal(session.executable, lspA);
    const untilLog = async (needle: string) => {
      for (let n = 0; n < 200; n++) { if (language.get()!.log.includes(needle)) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
      return false;
    };
    assert.equal(await untilLog("FIXTURE_LSP lsp-a"), true, language.get()!.log);
    await tools.setPath("clangd", lspB);
    assert.equal(await language.restartForTool("clangd"), true);
    const restarted = language.get()!;
    assert.equal(restarted.status, "ready");
    assert.ok(restarted.id > session.id);
    assert.equal(restarted.executable, lspB);
    assert.equal(await untilLog("FIXTURE_LSP lsp-b"), true, restarted.log);
    assert.equal(await language.restartForTool("platformio"), false);
    await language.stop();
    await languageWorkspace.close();
    await tasks.stopAll();
    await workspace.close();
    console.log("PASS tool settings: setting/env/PATH priority, user-data persistence and fresh-process restore, actual --version from a path with spaces and Chinese, invalid and missing path errors, build/compiledb/upload executable wiring, no tool swap mid-task, clangd restart with the new path (real CLI and LSP fixtures, not PlatformIO/clangd themselves)");
  } finally {
    if (environmentBefore === undefined) delete process.env.AETHER_PLATFORMIO_CLI;
    else process.env.AETHER_PLATFORMIO_CLI = environmentBefore;
    await fs.rm(toolTemp, { recursive: true, force: true });
  }
}
