import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TaskSnapshot, BuildArtifact, TaskEnvironment } from "../shared/desktop";
import type { WorkspaceService } from "./workspace";
export interface TaskProvider {
  id: string; executable: string | (() => string); args: string[] | ((options: Record<string, string>) => string[]); versionArgs?: string[];
  inputExcludes?: string[]; recordName?: string;
  // Host-side behavior is declared by the provider: main only reacts to this generic kind.
  kind?: string;
  // Runs after a successful task (still inside the explicit user action); the result is stored in .aether/<record>.
  afterSuccess?: (root: string, executable: string, options: Record<string, string>, signal: AbortSignal) => Promise<unknown>;
  // Providers that build one selected environment at a time expose what the project currently declares.
  environments?: (root: string, executable: string) => Promise<TaskEnvironment[]>;
  artifacts: (root: string, executable: string, options: Record<string, string>) => Promise<string[]>;
}
export class TaskService {
  private providers = new Map<string, TaskProvider>();
  private jobs = new Map<string, { task: TaskSnapshot; child: ChildProcess; done: Promise<void>; cancel: () => void; abort: AbortController }>();
  constructor(private workspace: WorkspaceService, private changed: (task: TaskSnapshot) => void = () => {}) {}
  register(provider: TaskProvider) { if (this.providers.has(provider.id)) throw new Error("Duplicate task provider: " + provider.id); this.providers.set(provider.id, provider); }
  list() { return [...this.jobs.values()].map((job) => structuredClone(job.task)); }
  async environments(id: string): Promise<TaskEnvironment[]> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("未注册的任务：" + id);
    if (!provider.environments) return [];
    const root = this.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    const executable = typeof provider.executable === "function" ? provider.executable() : provider.executable;
    return provider.environments(root, executable);
  }
  async start(id: string, options: Record<string, string> = {}) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("未注册的任务：" + id);
    const root = this.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    if (this.list().some((task) => task.status === "running")) throw new Error("已有任务运行，请等待或取消");
    // Resolve once so a settings change cannot swap the executable of a running task.
    const executable = typeof provider.executable === "function" ? provider.executable() : provider.executable;
    // The environment is fixed before the process starts; a settings change or a later UI selection cannot swap it.
    const environment = await this.resolveEnvironment(provider, root, executable, options.environment);
    const resolved = environment ? { ...options, environment } : options;
    const args = typeof provider.args === "function" ? provider.args(resolved) : provider.args;
    const toolVersion = provider.versionArgs ? (await promisify(execFile)(executable, provider.versionArgs, { cwd: root, timeout: 5000 })).stdout.trim() : undefined;
    const inputHash = await this.workspace.fingerprint(provider.inputExcludes);
    const task: TaskSnapshot = { id: randomUUID(), provider: id, root, environment, kind: provider.kind, status: "running", startedAt: new Date().toISOString(), exitCode: null, log: "$ " + executable + " " + args.join(" ") + "
", inputHash, toolVersion, options: { ...options }, artifacts: [] };
    const child = spawn(executable, args, { cwd: root, shell: false, detached: process.platform !== "win32", env: { ...process.env, PLATFORMIO_FORCE_COLOR: "false", PLATFORMIO_SETTING_ENABLE_TELEMETRY: "No" } });
    let cancelled = false;
    let processClosed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const emit = () => this.changed(structuredClone(task));
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", (error) => { task.error = error.message; emit(); });
      else { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { task.error = String(error); emit(); } } }
    };
    const abort = new AbortController();
    const cancel = () => { cancelled = true; abort.abort(); if (task.status !== "running" || processClosed) return; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 1500); };
    this.jobs.set(task.id, { task, child, done, cancel, abort });
    const append = (chunk: Buffer) => { task.log = (task.log + chunk.toString()).slice(-250000); emit(); };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    child.on("error", (error) => { task.error = error.message; });
    child.on("close", async (code) => {
      processClosed = true;
      clearTimeout(killTimer);
      task.exitCode = code;
      task.endedAt = new Date().toISOString();
      let result: TaskSnapshot["status"] = cancelled ? "cancelled" : code === 0 && !task.error ? "succeeded" : "failed";
      try {
        if (result === "succeeded") {
          if (inputHash !== await this.workspace.fingerprint(provider.inputExcludes)) throw new Error("构建期间源文件发生变化，未登记产物，请重新构建");
          let metadata: unknown;
          let metadataError = "";
          if (provider.afterSuccess) {
            try { metadata = await provider.afterSuccess(root, executable, resolved, abort.signal); }
            catch (error) {
              // The hook is part of the task: a cancellation stops here without writing a cache or a success record.
              if (cancelled) result = "cancelled";
              else {
                metadataError = String(error);
                task.log = (task.log + "\n[aether] 任务成功，但附加步骤失败：" + metadataError).slice(-250000);
              }
            }
          }
          if (result !== "cancelled") {
            // The hook can touch the project: verify inputs again and hash the final artifacts after it finished.
            if (inputHash !== await this.workspace.fingerprint(provider.inputExcludes)) throw new Error("任务附加步骤期间源文件发生变化，未登记产物，请重新构建");
            const artifacts: BuildArtifact[] = [];
            for (const relative of await provider.artifacts(root, executable, resolved)) {
              const bytes = await fs.readFile(path.join(root, relative));
              artifacts.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
            }
            if (!artifacts.length) throw new Error("进程已退出，但未找到构建产物");
            if (cancelled) result = "cancelled";
            else {
              task.artifacts = artifacts;
              await fs.mkdir(path.join(root, ".aether"), { recursive: true });
              await fs.writeFile(path.join(root, ".aether", provider.recordName ?? "build.json"), JSON.stringify({ ...task, status: result, ...(metadata !== undefined ? { metadata } : {}), ...(metadataError ? { metadataError } : {}) }, null, 2));
            }
          }
        }
      } catch (error) { result = "failed"; task.error = String(error); }
      task.status = result;
      emit(); finish();
    });
    emit(); return structuredClone(task);
  }
  private async resolveEnvironment(provider: TaskProvider, root: string, executable: string, requested?: string): Promise<string | undefined> {
    if (!provider.environments) return undefined;
    const declared = await provider.environments(root, executable);
    if (!declared.length) throw new Error("工程中没有可用的构建环境；请先在 platformio.ini 中声明 env:*");
    const wanted = requested?.trim();
    if (wanted) {
      if (!declared.some((item) => item.name === wanted)) throw new Error("未知的构建环境：" + wanted);
      return wanted;
    }
    const fallback = declared.find((item) => item.default) ?? declared[0];
    return fallback.name;
  }
  async cancel(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("任务不存在"); job.cancel(); await job.done; }
  async stopAll() { await Promise.all([...this.jobs.values()].filter((job) => job.task.status === "running").map((job) => this.cancel(job.task.id))); }
}
