import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TaskSnapshot, BuildArtifact } from "../shared/desktop";
import type { WorkspaceService } from "./workspace";
export interface TaskProvider {
  id: string; executable: string; args: string[] | ((options: Record<string, string>) => string[]); versionArgs?: string[];
  inputExcludes?: string[]; recordName?: string;
  artifacts: (root: string) => Promise<string[]>;
}
export class TaskService {
  private providers = new Map<string, TaskProvider>();
  private jobs = new Map<string, { task: TaskSnapshot; child: ChildProcess; done: Promise<void>; cancel: () => void }>();
  constructor(private workspace: WorkspaceService, private changed: (task: TaskSnapshot) => void = () => {}) {}
  register(provider: TaskProvider) { if (this.providers.has(provider.id)) throw new Error("Duplicate task provider: " + provider.id); this.providers.set(provider.id, provider); }
  list() { return [...this.jobs.values()].map((job) => structuredClone(job.task)); }
  async start(id: string, options: Record<string, string> = {}) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("未注册的任务：" + id);
    const root = this.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    if (this.list().some((task) => task.status === "running")) throw new Error("已有任务运行，请等待或取消");
    const args = typeof provider.args === "function" ? provider.args(options) : provider.args;
    const toolVersion = provider.versionArgs ? (await promisify(execFile)(provider.executable, provider.versionArgs, { cwd: root, timeout: 5000 })).stdout.trim() : undefined;
    const inputHash = await this.workspace.fingerprint(provider.inputExcludes);
    const task: TaskSnapshot = { id: randomUUID(), provider: id, root, status: "running", startedAt: new Date().toISOString(), exitCode: null, log: "$ " + provider.executable + " " + args.join(" ") + "\n", inputHash, toolVersion, artifacts: [] };
    const child = spawn(provider.executable, args, { cwd: root, shell: false, detached: process.platform !== "win32", env: { ...process.env, PLATFORMIO_FORCE_COLOR: "false", PLATFORMIO_SETTING_ENABLE_TELEMETRY: "No" } });
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
    const cancel = () => { if (task.status !== "running" || processClosed) return; cancelled = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 1500); };
    this.jobs.set(task.id, { task, child, done, cancel });
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
          const artifacts: BuildArtifact[] = [];
          for (const relative of await provider.artifacts(root)) {
            const bytes = await fs.readFile(path.join(root, relative));
            artifacts.push({ path: relative, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
          }
          if (!artifacts.length) throw new Error("进程已退出，但未找到构建产物");
          task.artifacts = artifacts;
          await fs.mkdir(path.join(root, ".aether"), { recursive: true });
          await fs.writeFile(path.join(root, ".aether", provider.recordName ?? "build.json"), JSON.stringify({ ...task, status: result }, null, 2));
        }
      } catch (error) { result = "failed"; task.error = String(error); }
      task.status = result;
      emit(); finish();
    });
    emit(); return structuredClone(task);
  }
  async cancel(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("任务不存在"); job.cancel(); await job.done; }
  async stopAll() { await Promise.all([...this.jobs.values()].filter((job) => job.task.status === "running").map((job) => this.cancel(job.task.id))); }
}
