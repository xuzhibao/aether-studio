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
interface ProcessRow { pid: number; ppid: number; pgid: number }
const processTable = async () => {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
  const rows = new Map<number, ProcessRow>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if ([pid, ppid, pgid].every(Number.isFinite)) rows.set(pid, { pid, ppid, pgid });
  }
  return rows;
};
// Only the PTY shell's own process tree and job groups are targets. mac ps sess is not a POSIX sid,
// so scanning by session id can select unrelated processes or report 0 for everything.
const ownedProcesses = (rootPid: number, rows: Map<number, ProcessRow>) => {
  const children = new Map<number, number[]>();
  for (const row of rows.values()) { const list = children.get(row.ppid) ?? []; list.push(row.pid); children.set(row.ppid, list); }
  const owned = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) { const parent = queue.shift()!; for (const child of children.get(parent) ?? []) if (!owned.has(child)) { owned.add(child); queue.push(child); } }
  // Job control puts jobs in process groups led by a descendant.
  let added = true;
  while (added) { added = false; for (const row of rows.values()) if (!owned.has(row.pid) && owned.has(row.pgid)) { owned.add(row.pid); added = true; } }
  return owned;
};
// A pid may have exited or been reused between the snapshot and the signal. Only keep pids that
// still belong to the captured tree or one of its job groups.
const verifyOwned = (pids: Iterable<number>, snapshot: Map<number, ProcessRow>, owned: Set<number>, current: Map<number, ProcessRow>) => {
  const groups = new Set([...owned].map((pid) => snapshot.get(pid)?.pgid).filter((pgid): pgid is number => typeof pgid === "number"));
  return [...pids].filter((pid) => {
    const before = snapshot.get(pid); const now = current.get(pid);
    if (!before || !now) return false;
    return (now.ppid === before.ppid && now.pgid === before.pgid) || owned.has(now.ppid) || groups.has(now.pgid);
  });
};
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
    if (!session.stopping) {
      const attempt = this.stopSession(session).catch((error) => { if (session.stopping === attempt) session.stopping = undefined; throw error; });
      session.stopping = attempt;
    }
    return session.stopping;
  }
  private async stopSession(session: Session) {
    const wasRunning = session.state.status === "running";
    session.state.status = "stopped"; this.emit(session);
    try {
      if (session.paused) { session.paused = false; session.process.resume(); }
      if (process.platform === "win32") {
        if (wasRunning) { await exec("taskkill", ["/pid", String(session.state.pid), "/T", "/F"]).catch((error) => { if (session.state.exitCode === null) throw error; }); session.process.kill(); }
      } else if (wasRunning) {
        const snapshot = await processTable();
        const owned = ownedProcesses(session.state.pid, snapshot);
        owned.delete(process.pid);
        const targets = [...owned].filter((pid) => pid !== session.state.pid);
        for (const pid of verifyOwned(targets, snapshot, owned, snapshot)) signal(pid, "SIGTERM");
        for (let n = 0; n < 10; n++) {
          const current = await processTable();
          const live = verifyOwned(targets, snapshot, owned, current).filter(alive);
          if (!live.length) break;
          await sleep(50);
        }
        for (const pid of verifyOwned(targets.filter(alive), snapshot, owned, await processTable())) signal(pid, "SIGKILL");
        try { session.process.kill("SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await session.done;
    } catch (error) {
      session.state.status = session.state.exitCode === null ? "running" : "exited";
      this.emit(session);
      throw error;
    }
  }
}
