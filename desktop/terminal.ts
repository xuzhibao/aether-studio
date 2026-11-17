import * as pty from "node-pty";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalSnapshot } from "../shared/terminal";
import type { WorkspaceService } from "./workspace";
export interface TerminalProvider { id: string; executable: string; args: string[] }
interface Session { state: TerminalSnapshot; process: pty.IPty; pending: string; paused: boolean; done: Promise<void>; stopping?: Promise<void> }
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const signal = (pid: number, name: NodeJS.Signals) => { try { process.kill(pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
export class TerminalService {
  private providers = new Map<string, TerminalProvider>();
  private session?: Session;
  private sequence = 0;
  constructor(private workspace: WorkspaceService, private changed: (state: TerminalSnapshot) => void = () => {}) {}
  register(provider: TerminalProvider) { if (this.providers.has(provider.id)) throw new Error("Duplicate terminal provider: " + provider.id); this.providers.set(provider.id, provider); }
  get() { return this.session ? structuredClone(this.session.state) : null; }
  private emit(session: Session) { this.changed(structuredClone(session.state)); }
  private dimensions(cols: number, rows: number) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) throw new Error("终端尺寸无效"); }
  private require(id: number, running = false) {
    if (this.session?.state.id !== id || (running && this.session.state.status !== "running")) throw new Error("终端会话已关闭");
    return this.session;
  }
  async start(providerId: string, root: string, cols: number, rows: number) {
    if (root !== this.workspace.root) throw new Error("请先打开对应的磁盘工程");
    this.dimensions(cols, rows);
    if (this.session?.state.status === "running") {
      if (this.session.state.root !== root || this.session.state.provider !== providerId) throw new Error("请先停止已有终端");
      this.resize(this.session.state.id, cols, rows); return this.get()!;
    }
    await this.stop();
    const provider = this.providers.get(providerId); if (!provider) throw new Error("未注册的终端：" + providerId);
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }; delete env.ELECTRON_RUN_AS_NODE;
    const child = pty.spawn(provider.executable, provider.args, { cwd: root, cols, rows, name: "xterm-256color", env });
    const state: TerminalSnapshot = { id: ++this.sequence, provider: providerId, root, shell: provider.executable, pid: child.pid, status: "running", cols, rows, exitCode: null, signal: null };
    let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const session: Session = { state, process: child, pending: "", paused: false, done }; this.session = session;
    child.onData((data) => {
      if (state.status === "stopped") return;
      session.pending += data;
      // Reading resumes only as xterm consumes the previous chunk, bounding IPC/renderer queues.
      if (!session.paused && session.pending.length >= 256 * 1024) { child.pause(); session.paused = true; }
    });
    child.onExit(({ exitCode, signal }) => { state.exitCode = exitCode; state.signal = signal ?? null; if (state.status === "running") state.status = "exited"; this.emit(session); finish(); });
    this.emit(session); return structuredClone(state);
  }
  read(id: number) {
    const session = this.require(id); const data = session.pending; session.pending = "";
    if (session.paused) { session.paused = false; session.process.resume(); }
    return data;
  }
  write(id: number, data: string) { this.require(id, true).process.write(data); }
  resize(id: number, cols: number, rows: number) {
    this.dimensions(cols, rows); const session = this.require(id, true);
    session.process.resize(cols, rows); session.state.cols = cols; session.state.rows = rows; this.emit(session);
  }
  async stop(id?: number) {
    const session = this.session; if (!session || (id !== undefined && session.state.id !== id)) return;
    return session.stopping ??= this.stopSession(session);
  }
  private async stopSession(session: Session) {
    const wasRunning = session.state.status === "running";
    session.state.status = "stopped"; this.emit(session);
    if (session.paused) { session.paused = false; session.process.resume(); }
    if (process.platform === "win32") {
      if (wasRunning) { await exec("taskkill", ["/pid", String(session.state.pid), "/T", "/F"]).catch((error) => { if (session.state.exitCode === null) throw error; }); session.process.kill(); }
    } else {
      // Interactive job control creates multiple process groups. Stop the whole PTY session.
      const { stdout } = await exec("ps", ["-A", "-o", process.platform === "darwin" ? "pid=,sess=" : "pid=,sid="]);
      const rows = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/));
      const sid = process.platform === "darwin" ? rows.find(([pid]) => Number(pid) === session.state.pid)?.[1] : String(session.state.pid);
      const targets = rows.filter(([, value]) => sid && value === sid).map(([pid]) => Number(pid));
      for (const pid of targets) signal(pid, "SIGTERM");
      for (let n = 0; n < 10 && targets.some(alive); n++) await sleep(50);
      for (const pid of targets.filter(alive)) signal(pid, "SIGKILL");
      if (wasRunning) session.process.kill("SIGKILL");
    }
    await session.done;
  }
}
