import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertEnvironmentName } from "../buildInputs";
import { deviceLease, normalizePort, type DeviceLeaseToken } from "../deviceLock";
import type { TaskSnapshot } from "../../shared/desktop";
import { FwValSession, type FwValRecord, type FwValTransport } from "../../shared/firmwareValidation";
import {
  verifyMonitorEvidence,
  verifySimulationEvidence,
  type EspDeployExpectation,
  type EspDeployRecord,
  type EspMonitorEvidence,
  type EspSimulationEvidence,
  type EspSimulationVerdict,
} from "../esp/deployGate";
import type { SerialService } from "../plugins/serial";
import type { ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";
import { createQemuSimulator, type QemuSimulatorService, type SimulatorSnapshot } from "./qemu";

// Product-side firmware verification.
//
// One QEMU run proves the app boots and answers a challenge the host generated for this run. The
// record it produces is host-owned and binds the exact app SHA-256, the PlatformIO environment and
// the project input fingerprint. The app-only deploy gate reads this record; the renderer has no
// parameter that can forge or relax it. The physical-board challenge always opens a NEW serial
// session on the port that was just written and is bound to the real deploy plan digest.

const SHA256 = /^[0-9a-f]{64}$/;
const BOOT_BANNER = "ESP-ROM:esp32c3";
const DEVICE_BAUD = 115200;
const DEFAULT_BOOTS = 2;
const POLL_MS = 50;
const MAX_TIMEOUT = 300_000;

export interface VirtualBoot {
  record: FwValRecord;
  appSha256: string;
  status: SimulatorSnapshot["status"];
  stopReason?: SimulatorSnapshot["stopReason"];
  pid: number | null;
  exitCode: number | null;
  error?: string;
  uartChars: number;
  bootBanner: boolean;
  qemu: { executable: string; version: string };
  build: { recordSha256: string; inputHash: string; builtAt: string };
  flash: { sha256: string; size: number; appBytes: number };
  argv: string[];
  uartTail: string;
}

export interface QemuEvidence {
  version: 1;
  id: string;
  passed: boolean;
  root: string;
  environment: string;
  appSha256: string;
  inputHash: string;
  recordedAt: string;
  startedAt: string;
  boots: VirtualBoot[];
  identity: { fwid: string; stable: boolean };
  error?: string;
}

export interface ArmedDeploy {
  evidenceId: string;
  root: string;
  environment: string;
  appSha256: string;
  inputHash: string;
  port: string;
  armedAt: string;
}

export interface HardwareEvidence {
  version: 1;
  id: string;
  passed: boolean;
  bound: boolean;
  root: string;
  port: string;
  transport: FwValTransport;
  environment: string;
  appSha256: string | null;
  planSha256: string | null;
  sessionId: number;
  recordedAt: string;
  record: FwValRecord;
  reason: string;
}

export interface VerificationStatus {
  running: boolean;
  live: SimulatorSnapshot | null;
  evidence: QemuEvidence | null;
  armed: ArmedDeploy | null;
  hardware: HardwareEvidence | null;
  error: string;
}

export interface VerificationOptions {
  tools: ToolService;
  workspace: WorkspaceService;
  serial: SerialService;
  tasks: { list: () => TaskSnapshot[] };
  directory: () => string;
  trashItem?: (target: string) => Promise<void>;
  emit?: (status: VerificationStatus) => void;
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fresh random 16-hex token; the device answer is recomputed by the shared pure matcher. */
const freshToken = () => randomBytes(8).toString("hex");

const tail = (text: string, size = 4000) => (text.length > size ? text.slice(-size) : text);

export class FirmwareVerificationService {
  private simulator: QemuSimulatorService;
  private running = false;
  private cancelled = false;
  private live: SimulatorSnapshot | null = null;
  private evidence: QemuEvidence | null = null;
  private armed: ArmedDeploy | null = null;
  private hardware: HardwareEvidence | null = null;
  private error = "";
  private hardwareLease: DeviceLeaseToken | null = null;
  private priorSessions: number[] = [];

  constructor(private options: VerificationOptions) {
    this.simulator = this.makeSimulator();
  }

  private makeSimulator() {
    return createQemuSimulator({
      tools: this.options.tools,
      workspace: this.options.workspace,
      trashItem: this.options.trashItem,
      emit: (snapshot) => {
        this.live = snapshot;
        this.notify();
      },
    });
  }

  private notify() {
    try {
      this.options.emit?.(this.status());
    } catch {
      /* a listener must not break a run */
    }
  }

  status(): VerificationStatus {
    return {
      running: this.running,
      live: this.live ? clone(this.live) : null,
      evidence: this.evidence ? clone(this.evidence) : null,
      armed: this.armed ? clone(this.armed) : null,
      hardware: this.hardware ? clone(this.hardware) : null,
      error: this.error,
    };
  }

  latestEvidence() {
    return this.evidence ? clone(this.evidence) : null;
  }

  armedDeploy() {
    return this.armed ? clone(this.armed) : null;
  }

  isArmed() {
    return this.armed !== null;
  }

  disarm() {
    this.armed = null;
    void this.persistArmed();
    this.notify();
  }

  /**
   * Project switch or workspace close: an old project's evidence, authorization and hardware
   * verdict must not remain visible for the next project.
   */
  clear() {
    this.evidence = null;
    this.armed = null;
    this.hardware = null;
    this.live = null;
    this.error = "";
    this.priorSessions = [];
    void this.persistArmed();
    this.notify();
  }

  /** One host-trusted record for the deploy gate. Never accepts renderer data. */
  gateEvidence(): EspSimulationEvidence | null {
    const evidence = this.evidence;
    if (!evidence) return null;
    return {
      version: 1,
      passed: evidence.passed,
      appSha256: evidence.appSha256,
      environment: evidence.environment,
      inputHash: evidence.inputHash,
      recordedAt: evidence.recordedAt,
      source: "qemu.esp32c3:" + evidence.id + ":boots=" + evidence.boots.length + ":fwid=" + evidence.identity.fwid,
    };
  }

  /**
   * Runs in addition to C's strict comparison. The record must belong to the armed port/environment
   * and to the same workspace, so a pass for one target cannot authorize another port.
   */
  verifyGate(evidence: EspSimulationEvidence | null, expected: EspDeployExpectation): EspSimulationVerdict {
    const armed = this.armed;
    if (!armed) return { allowed: false, reason: "没有为本次写入启用固件验证（app-only）" };
    if (!this.evidence || this.evidence.id !== armed.evidenceId) return { allowed: false, reason: "固件验证证据已变化，请重新验证" };
    if (!this.options.workspace.root || path.resolve(this.options.workspace.root) !== path.resolve(armed.root)) return { allowed: false, reason: "证据属于另一个工程目录" };
    if (expected.environment !== armed.environment) return { allowed: false, reason: "写入环境 " + expected.environment + " 与已验证环境 " + armed.environment + " 不一致" };
    if (normalizePort(expected.port) !== normalizePort(armed.port)) return { allowed: false, reason: "写入端口 " + expected.port + " 与已启用验证的端口 " + armed.port + " 不一致" };
    return verifySimulationEvidence(evidence, expected);
  }

  /** Arms the next esp.upload task for app-only. Only a passed, current record can arm. */
  async armDeploy(options: { port: string }): Promise<ArmedDeploy> {
    const evidence = this.evidence;
    if (!evidence || !evidence.passed) throw new Error("没有可用的固件验证通过记录；请先完成真实 QEMU 验证");
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    if (path.resolve(root) !== path.resolve(evidence.root)) throw new Error("最近的验证记录属于另一个工程目录");
    const fingerprint = await this.options.workspace.fingerprint().catch(() => "");
    if (fingerprint !== evidence.inputHash) throw new Error("验证之后工程文件已变化，请重新构建并验证");
    const port = options.port?.trim();
    if (!port) throw new Error("请先选择实机串口");
    this.armed = {
      evidenceId: evidence.id, root, environment: evidence.environment, appSha256: evidence.appSha256,
      inputHash: evidence.inputHash, port, armedAt: new Date().toISOString(),
    };
    await this.persistArmed();
    this.notify();
    return clone(this.armed);
  }

  consumeArmed() {
    this.armed = null;
    void this.persistArmed();
    this.notify();
  }

  cancel(): Promise<void> {
    if (this.running) this.cancelled = true;
    return this.simulator.cancel();
  }

  dispose() {
    return this.cancel();
  }

  /**
   * Real QEMU verification. Every boot is a separate process reading its own private copy of the
   * exact flash image assembled from the successful build record. The challenge is fresh per boot.
   */
  async runSimulation(options: { environment: string; boots?: number; timeoutMs?: number }): Promise<QemuEvidence> {
    if (this.running) throw new Error("固件验证已在运行，请先取消");
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    const environment = typeof options.environment === "string" ? options.environment.trim() : "";
    assertEnvironmentName(environment);
    const boots = options.boots ?? DEFAULT_BOOTS;
    // A single boot cannot demonstrate a stable identity; authorizing evidence always needs two.
    if (!Number.isInteger(boots) || boots < 2 || boots > 4) throw new Error("启动次数必须是 2–4 的整数");
    const timeoutMs = options.timeoutMs ?? 45_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > MAX_TIMEOUT) throw new Error("单次超时必须是 5000–" + MAX_TIMEOUT + " 毫秒");

    this.running = true;
    this.cancelled = false;
    this.error = "";
    this.hardware = null;
    // A new run invalidates any deploy authorization; the old record also stops authorizing writes.
    this.armed = null;
    this.evidence = null;
    this.live = null;
    this.notify();
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    const runs: VirtualBoot[] = [];
    let failure = "";
    try {
      for (let index = 0; index < boots; index++) {
        if (this.cancelled) {
          failure = "已取消";
          break;
        }
        const snapshot = await this.simulator.start({ environment, timeoutMs });
        const { record } = await this.drive(snapshot, timeoutMs);
        // Stop the emulator even when the challenge passed: one verification, one bounded process.
        await this.simulator.cancel().catch(() => {});
        const final = this.simulator.snapshot() ?? snapshot;
        const boot: VirtualBoot = {
          record,
          appSha256: snapshot.app.sha256,
          status: final.status,
          ...(final.stopReason ? { stopReason: final.stopReason } : {}),
          pid: final.pid ?? snapshot.pid,
          exitCode: final.exitCode,
          ...(final.error ? { error: final.error } : {}),
          uartChars: Math.max(snapshot.uartChars, final.uartChars),
          bootBanner: (snapshot.uart + final.uart).includes(BOOT_BANNER),
          qemu: snapshot.qemu,
          build: snapshot.build,
          flash: { sha256: snapshot.flash.sha256, size: snapshot.flash.size, appBytes: snapshot.app.size },
          argv: snapshot.argv,
          uartTail: tail(final.uart),
        };
        runs.push(boot);
        if (record.verdict !== "pass") {
          failure = "第 " + (index + 1) + " 次启动未通过：" + (record.failure ? record.failure.code + " " + record.failure.detail : record.phase);
          break;
        }
        if (!boot.bootBanner) {
          failure = "第 " + (index + 1) + " 次启动没有 ESP32-C3 ROM 启动横幅";
          break;
        }
        if (boot.status !== "stopped" || boot.error) {
          failure = "第 " + (index + 1) + " 次 QEMU 未干净结束（status=" + boot.status + (boot.error ? "：" + boot.error : "") + "）";
          break;
        }
        if (!SHA256.test(boot.appSha256)) {
          failure = "启动记录缺少 app SHA-256";
          break;
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.running = false;
      await this.simulator.cancel().catch(() => {});
    }
    const first = runs[0];
    const sameApp = runs.every((boot) => boot.appSha256 === first?.appSha256);
    const sameFwid = runs.every((boot) => boot.record.device?.fwid === first?.record.device?.fwid);
    const allPassed = runs.length === boots && runs.every((boot) => boot.record.verdict === "pass" && boot.bootBanner && boot.status === "stopped" && !boot.error);
    const passed = !failure && allPassed && sameApp && sameFwid && !!first?.record.device?.fwid;
    if (!failure && !passed) failure = "启动之间镜像或固件标识不一致";
    const evidence: QemuEvidence = {
      version: 1,
      id,
      passed,
      root,
      environment,
      appSha256: first?.appSha256 ?? "",
      inputHash: first?.build.inputHash ?? "",
      recordedAt: new Date().toISOString(),
      startedAt,
      boots: runs,
      identity: { fwid: first?.record.device?.fwid ?? "", stable: sameFwid && runs.length >= 2 },
      ...(failure ? { error: failure } : {}),
    };
    this.evidence = evidence;
    this.error = failure;
    await this.persistEvidence().catch((error) => {
      this.error = (this.error ? this.error + "；" : "") + "写入证据失败：" + String(error);
    });
    this.notify();
    return clone(evidence);
  }

  /** Feeds real QEMU UART bytes into the shared matcher; the matcher alone decides pass/fail. */
  private async drive(snapshot: SimulatorSnapshot, timeoutMs: number): Promise<{ record: FwValRecord }> {
    const session = new FwValSession({ runId: "qemu-" + snapshot.id.slice(0, 8), transport: "qemu-uart0" });
    let cursor = 0;
    let issued = false;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = this.simulator.snapshot() ?? snapshot;
      try {
        const read = this.simulator.readUart(cursor);
        cursor = read.offset;
        if (read.text) session.feed(Buffer.from(read.text, "utf8"));
      } catch {
        /* the retained window rolled past a slow poll; the next read still advances */
      }
      if (session.currentPhase === "ready" && !issued) {
        const token = freshToken();
        session.issueChallenge(token);
        this.simulator.writeUart("CHALLENGE token=" + token + "\n");
        issued = true;
      }
      session.tick();
      if (session.currentPhase === "passed" || session.currentPhase === "failed") return { record: session.finish() };
      if (this.cancelled) {
        session.disconnect("宿主已取消");
        return { record: session.finish() };
      }
      if (current.status !== "running") {
        session.disconnect("QEMU 已退出（status=" + current.status + (current.error ? "：" + current.error : "") + "）");
        return { record: session.finish() };
      }
      if (Date.now() > deadline) {
        session.disconnect("宿主硬超时");
        return { record: session.finish() };
      }
      await wait(POLL_MS);
    }
  }

  /**
   * Independent physical-board challenge: a NEW serial session after the write. The upload exit code
   * is never accepted as runtime proof; only a matching response on this session counts.
   */
  async runDevice(options: { port: string; transport?: FwValTransport; timeoutMs?: number }): Promise<HardwareEvidence> {
    if (this.running) throw new Error("固件验证已在运行，请先取消");
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    const port = options.port?.trim();
    if (!port) throw new Error("请先明确选择实机串口");
    const transport: FwValTransport = options.transport ?? "usb-serial-jtag";
    if (!["uart0", "usb-serial-jtag"].includes(transport)) throw new Error("实机挑战只支持 uart0 或 usb-serial-jtag");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const qemu = this.evidence;
    if (!qemu || !qemu.passed) throw new Error("没有通过的 QEMU 验证记录；实机挑战必须与同一镜像的仿真结果对比");
    if (path.resolve(root) !== path.resolve(qemu.root)) throw new Error("仿真记录属于另一个工程目录");
    // The device must be running the image this evidence was recorded for. A protocol identity
    // string is not an image digest, so the app SHA and environment are compared explicitly.
    const deploy = this.latestDeploy(port);
    if (!deploy) throw new Error("没有找到与端口 " + port + " 匹配的已成功 app-only 上传记录；无法把实机回包绑定到本次验证");
    if (deploy.appSha256.toLowerCase() !== qemu.appSha256.toLowerCase()) throw new Error("最近一次写入的 app SHA 与当前 QEMU 证据不一致（写入 " + deploy.appSha256 + "，仿真 " + qemu.appSha256 + "）");
    if (deploy.environment !== qemu.environment) throw new Error("最近一次写入的环境与当前 QEMU 证据不一致（写入 " + deploy.environment + "，仿真 " + qemu.environment + "）");
    const expectedFwid = qemu.identity.fwid;

    this.running = true;
    this.cancelled = false;
    this.error = "";
    this.notify();
    const startedAt = new Date().toISOString();
    const token = freshToken();
    const session = new FwValSession({ runId: "device-" + randomUUID().slice(0, 8), transport, expectedFwid });
    let sessionId = 0;
    let issued = false;
    let reason = "";
    let record: FwValRecord;
    let lease: DeviceLeaseToken | null = null;
    try {
      // Claim inside the guarded block: a busy port must not leave `running` stuck forever.
      lease = deviceLease.claim("verification", port);
      this.hardwareLease = lease;
      sessionId = await this.options.serial.open(port, DEVICE_BAUD);
      this.priorSessions.push(sessionId);
      // Ask for the identity explicitly: the app may have booted long before this new session.
      let helloSentAt = 0;
      let helloCount = 0;
      const sendHello = async () => {
        await this.options.serial.write(sessionId, Array.from(Buffer.from("HELLO\n", "utf8")));
        helloSentAt = Date.now();
        helloCount += 1;
      };
      await sendHello();
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const bytes = await this.options.serial.read(sessionId).catch((error) => {
          session.disconnect(String(error));
          return [] as number[];
        });
        if (bytes.length) session.feed(Uint8Array.from(bytes));
        // One retry if the first HELLO raced the USB driver install; never more than two.
        if (session.currentPhase === "awaiting-ready" && helloCount < 2 && helloSentAt && Date.now() - helloSentAt > 1500) await sendHello();
        if (session.currentPhase === "ready" && !issued) {
          try {
            session.issueChallenge(token);
            await this.options.serial.write(sessionId, Array.from(Buffer.from("CHALLENGE token=" + token + "\n", "utf8")));
            issued = true;
          } catch (error) {
            session.disconnect(String(error));
          }
        }
        session.tick();
        if (session.currentPhase === "passed" || session.currentPhase === "failed") break;
        if (this.cancelled) {
          session.disconnect("宿主已取消");
          break;
        }
        if (Date.now() > deadline) {
          session.disconnect("宿主硬超时");
          break;
        }
        await wait(POLL_MS);
      }
      record = session.finish();
    } catch (error) {
      session.disconnect(error instanceof Error ? error.message : String(error));
      record = session.finish();
    } finally {
      if (sessionId) await this.options.serial.close(sessionId).catch(() => {});
      deviceLease.release(lease);
      this.hardwareLease = null;
      this.running = false;
    }
    let bound = false;
    if (record.verdict === "pass") {
      const monitor: EspMonitorEvidence = {
        sessionId: String(sessionId), port, challenge: token, startedAt,
        challengeObserved: record.response?.token === token && record.challenge?.token === token,
        outputObserved: record.bytesIn > 0 && record.device !== null,
      };
      const checked = verifyMonitorEvidence(deploy, monitor, { priorSessionIds: this.priorSessions.filter((item) => item !== sessionId).map(String) });
      bound = checked.ok;
      if (!checked.ok) reason = checked.reason;
    } else reason = record.failure ? record.failure.code + " " + record.failure.detail : "挑战未通过";
    const evidence: HardwareEvidence = {
      version: 1,
      id: randomUUID(),
      passed: record.verdict === "pass" && bound,
      bound,
      root,
      port,
      transport,
      environment: deploy.environment,
      appSha256: deploy.appSha256,
      planSha256: deploy.planSha256,
      sessionId,
      recordedAt: new Date().toISOString(),
      record,
      reason,
    };
    this.hardware = evidence;
    this.notify();
    return clone(evidence);
  }

  /** Latest successful esp.upload for this project and port, with the plan digest it actually ran. */
  private latestDeploy(port: string): EspDeployRecord | null {
    const root = this.options.workspace.root;
    const task = this.options.tasks
      .list()
      .filter((item) => item.provider === "esp.upload" && item.status === "succeeded" && item.root === root)
      .filter((item) => normalizePort(String(item.options?.port ?? "")) === normalizePort(port))
      .sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt))
      .at(-1);
    if (!task) return null;
    const metadata = task.metadata as { simulation?: { appSha256?: string; planSha256?: string }; appOnly?: { mode?: string } } | undefined;
    const simulation = metadata?.simulation;
    // Only an app-only write carries the verified single-app binding. A full-plan write may also
    // contain a simulation record, but it must never authorize the hardware challenge.
    if (!metadata?.appOnly || metadata.appOnly.mode !== "app-only") return null;
    if (!simulation || !SHA256.test(String(simulation.appSha256 ?? "")) || !SHA256.test(String(simulation.planSha256 ?? ""))) return null;
    return {
      port,
      environment: task.environment ?? "",
      appSha256: String(simulation.appSha256),
      planSha256: String(simulation.planSha256),
      recordedAt: task.endedAt ?? task.startedAt,
    };
  }

  private directory() {
    return this.options.directory();
  }

  private async persistEvidence() {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "qemu-evidence.json");
    const temporary = file + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(this.evidence, null, 2));
    await fs.rename(temporary, file);
  }

  private async persistArmed() {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "armed-deploy.json");
    const temporary = file + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(this.armed));
    await fs.rename(temporary, file);
  }
}
