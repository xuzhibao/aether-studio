import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertEnvironmentName } from "../buildInputs";
import { deviceLease, normalizePort, type DeviceLeaseToken } from "../deviceLock";
import type { TaskSnapshot } from "../../shared/desktop";
import { evaluatePreflight } from "../../shared/esp";
import { FwValSession, FwValStabilityMonitor, type FwValRecord, type FwValTransport } from "../../shared/firmwareValidation";
import { verifyAppOnlyTarget } from "../esp/appOnly";
import {
  verifyMonitorEvidence,
  verifySimulationEvidence,
  type EspDeployExpectation,
  type EspDeployRecord,
  type EspMonitorEvidence,
  type EspSimulationEvidence,
  type EspSimulationVerdict,
  type VerifiedDeployIntent,
} from "../esp/deployGate";
import { findEsptool } from "../esp/esptool";
import { readDeviceFacts } from "../esp/inspect";
import { applyBuildRecord, buildPreflightInput } from "../esp/preflight";
import { readEspProject } from "../esp/project";
import { writeRanges } from "../esp/upload";
import type { SerialService } from "../plugins/serial";
import type { ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";
import { createQemuSimulator, type QemuSimulatorService, type SimulatorSnapshot } from "./qemu";

// Product-side firmware verification.
//
// One QEMU run proves the app boots and answers a challenge the host generated for this run. The
// record it produces is host-owned and binds the exact app SHA-256, the PlatformIO environment and
// the project input fingerprint. An explicit preview re-proves the same target on the live device
// and issues a one-time write token; the commit starts the existing esp.upload provider without a
// build or a save, and the provider re-proves device, active slot, build record and artifacts while
// it holds the port lease. The renderer cannot widen or reuse that authorization. The physical-board
// challenge always opens a NEW serial session on the port that was just written and is bound to the
// real deploy plan digest.

const SHA256 = /^[0-9a-f]{64}$/;
const BOOT_BANNER = "ESP-ROM:esp32c3";
const DEVICE_BAUD = 115200;
const DEFAULT_BOOTS = 2;
const POLL_MS = 50;
const MAX_TIMEOUT = 300_000;
const PREVIEW_TTL_MS = 120_000;

/** Internal task option that only the explicit commit writes; the generic tasks IPC strips it. */
export const VERIFIED_WRITE_OPTION = "__aetherVerifiedWrite";

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

/** Host-only one-time preview. The renderer receives every field except the internal evidence checks. */
export interface VerifiedDeployPreview {
  token: string;
  evidenceId: string;
  root: string;
  environment: string;
  port: string;
  appSha256: string;
  inputHash: string;
  device: { chipName: string; revision: string; flashSize: number | null };
  slot: { label: string; offset: number; size: number };
  erase: { offset: number; size: number };
  app: { offset: number; size: number };
  previewedAt: string;
  expiresAt: string;
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

/**
 * Post-write runtime evidence for the automatic firmware task. The challenge, the twenty COUNT
 * replies and the quiet observation all happen in ONE new session opened after this round's write,
 * under the same port lease, and are bound to that exact upload task and plan digest.
 */
export interface StabilityEvidence {
  version: 1;
  id: string;
  passed: boolean;
  root: string;
  port: string;
  transport: FwValTransport;
  environment: string;
  taskId: string;
  appSha256: string;
  planSha256: string;
  sessionId: number;
  challenge: { token: string; passed: boolean; bound: boolean; reason: string };
  counts: number[];
  observeMs: number;
  observedMs: number;
  strictlyIncreasing: boolean;
  restartDetected: boolean;
  restartMarkers: string[];
  recordedAt: string;
  reason: string;
}

export interface VerificationStatus {
  running: boolean;
  live: SimulatorSnapshot | null;
  evidence: QemuEvidence | null;
  preview: VerifiedDeployPreview | null;
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
  /** True while the editor has unsaved buffers; a preview or write must not use a stale disk state. */
  unsaved?: () => boolean;
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
  private preview: VerifiedDeployPreview | null = null;
  private writeIntent: VerifiedDeployIntent | null = null;
  private activeIntent: VerifiedDeployIntent | null = null;
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
      preview: this.preview ? clone(this.preview) : null,
      hardware: this.hardware ? clone(this.hardware) : null,
      error: this.error,
    };
  }

  latestEvidence() {
    return this.evidence ? clone(this.evidence) : null;
  }

  disarm() {
    this.preview = null;
    this.writeIntent = null;
    this.activeIntent = null;
    this.notify();
  }

  /**
   * Project switch or workspace close: an old project's evidence, preview and hardware verdict must
   * not remain visible for the next project.
   */
  clear() {
    this.evidence = null;
    this.preview = null;
    this.writeIntent = null;
    this.activeIntent = null;
    this.hardware = null;
    this.live = null;
    this.error = "";
    this.priorSessions = [];
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
   * Runs in addition to the gate's strict comparison. The intent must be the one issued by the
   * explicit commit and still belong to the current record, project, environment, port and private
   * app bytes. A generic deploy never carries the marker, so it cannot reach this path at all.
   */
  verifyGate(evidence: EspSimulationEvidence | null, expected: EspDeployExpectation, options?: Record<string, string>): EspSimulationVerdict {
    const intent = this.activeIntent;
    if (!intent || !options || options[VERIFIED_WRITE_OPTION] !== intent.id) return { allowed: false, reason: "没有显式验证写入意图" };
    if (!this.evidence || this.evidence.id !== intent.evidenceId) return { allowed: false, reason: "固件验证证据已变化，请重新验证" };
    if (!this.options.workspace.root || path.resolve(this.options.workspace.root) !== path.resolve(intent.root)) return { allowed: false, reason: "写入工程目录与验证时不一致" };
    if (expected.environment !== intent.environment) return { allowed: false, reason: "写入环境 " + expected.environment + " 与已验证环境 " + intent.environment + " 不一致" };
    if (normalizePort(expected.port) !== normalizePort(intent.port)) return { allowed: false, reason: "写入端口 " + expected.port + " 与已核对端口 " + intent.port + " 不一致" };
    if (expected.appSha256.toLowerCase() !== intent.appSha256.toLowerCase()) return { allowed: false, reason: "私有快照中的 app 与已验证 app 不一致" };
    if (expected.inputHash !== intent.inputHash) return { allowed: false, reason: "核对写入之后工程文件又发生了变化" };
    return verifySimulationEvidence(evidence, expected);
  }

  /**
   * The upload provider's only route to app-only. It consumes the intent created by commitDeploy;
   * the marker is never accepted by the generic tasks IPC. No intent means the full existing plan.
   */
  takeWriteIntent(options: Record<string, string>): VerifiedDeployIntent | null {
    const id = options[VERIFIED_WRITE_OPTION];
    if (!id || !this.writeIntent || this.writeIntent.id !== id) return null;
    const intent = this.writeIntent;
    this.writeIntent = null;
    this.activeIntent = intent;
    return clone(intent);
  }

  abortWrite(id: string) {
    if (this.writeIntent?.id === id) this.writeIntent = null;
    if (this.activeIntent?.id === id) this.activeIntent = null;
  }

  /**
   * Read-only preview of one app-only write. It re-proves the passed QEMU record, the successful
   * build record and artifacts, the live device and the active OTA slot, then issues a one-time
   * token that expires. It does not arm the generic deploy dialog or any ambient permission.
   */
  async previewDeploy(options: { environment: string; port: string }): Promise<VerifiedDeployPreview> {
    if (this.running) throw new Error("固件验证正在运行，请先等待或取消");
    // A new check invalidates the previous token even when this one fails: never leave an older
    // preview that the UI could still display as current. A new target also invalidates any prior
    // hardware conclusion, which belonged to a different write.
    this.preview = null;
    this.writeIntent = null;
    this.activeIntent = null;
    this.hardware = null;
    this.notify();
    if (this.options.unsaved?.()) throw new Error("工程有未保存的编辑，请先保存再核对写入");
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    const environment = typeof options.environment === "string" ? options.environment.trim() : "";
    if (!environment) throw new Error("请先选择 PlatformIO 环境");
    const port = typeof options.port === "string" ? options.port.trim() : "";
    if (!port) throw new Error("请先选择实机串口");
    const evidence = this.evidence;
    if (!evidence || !evidence.passed) throw new Error("没有通过的 QEMU 验证记录；请先完成两次真实启动");
    if (path.resolve(root) !== path.resolve(evidence.root)) throw new Error("QEMU 记录属于另一个工程目录");
    if (environment !== evidence.environment) throw new Error("QEMU 记录属于环境 " + evidence.environment + "，不是 " + environment);
    const fingerprint = await this.options.workspace.fingerprint().catch(() => "");
    if (!fingerprint || fingerprint !== evidence.inputHash) throw new Error("QEMU 验证之后工程文件已变化，请重新验证");

    const found = await findEsptool(this.options.tools);
    if (!found.tool) throw new Error(found.reason || "找不到 esptool");
    const tool = found.tool;
    const facts = await readEspProject(root, environment, this.options.tools.executable("platformio"), this.options.tools, this.options.workspace);
    if (!facts.supported) throw new Error(facts.skipped || "该工程不是 ESP 目标");
    if (facts.recordProblem) throw new Error(facts.recordProblem + "；请重新构建后再核对");
    if (facts.app.sha256.toLowerCase() !== evidence.appSha256.toLowerCase()) throw new Error("构建的 app 与 QEMU 记录不一致，请重新构建并验证");

    let lease: DeviceLeaseToken | null = null;
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "aether-verified-preview-"));
    try {
      lease = deviceLease.claim("verification", port);
      const device = await readDeviceFacts(tool, port);
      if (!device.ok) throw new Error("无法读取设备：" + device.error);
      const result = applyBuildRecord(evaluatePreflight(buildPreflightInput(facts, port, device)), facts);
      const blocks = result.findings.filter((finding) => finding.severity === "block");
      if (blocks.length) throw new Error("写入前核对未通过：" + blocks.map((finding) => finding.title + "（" + finding.next + "）").join("；"));
      const appSegments = result.segments.filter((segment) => segment.name === "app");
      if (appSegments.length !== 1) throw new Error("写入计划必须恰好包含一个 app 段（" + appSegments.length + "）");
      const target = await verifyAppOnlyTarget({ tool, port, directory: scratch, device, project: facts, appOffset: appSegments[0].offset, appSize: appSegments[0].size, appSha256: appSegments[0].sha256 });
      if (target.appSha256 !== evidence.appSha256.toLowerCase()) throw new Error("活动槽中的目标 app 与 QEMU 记录不一致");
      if (this.options.workspace.root !== root) throw new Error("核对期间工程目录已切换");
      const ranges = writeRanges([appSegments[0]]);
      if (ranges.length !== 1 || ranges[0].offset !== target.erase.offset || ranges[0].size !== target.erase.size) throw new Error("app-only 擦除范围与已核对目标不一致");
      const now = Date.now();
      const preview: VerifiedDeployPreview = {
        token: randomBytes(24).toString("hex"),
        evidenceId: evidence.id,
        root,
        environment,
        port,
        appSha256: target.appSha256,
        inputHash: evidence.inputHash,
        device: { chipName: device.chipName, revision: device.revision, flashSize: device.flashSize },
        slot: { label: target.partition.label, offset: target.partition.offset, size: target.partition.size },
        erase: { offset: target.erase.offset, size: target.erase.size },
        app: { offset: target.appOffset, size: target.appSize },
        previewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
      };
      this.preview = preview;
      this.writeIntent = null;
      this.activeIntent = null;
      this.notify();
      return clone(preview);
    } finally {
      deviceLease.release(lease);
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Consumes the preview token and creates the one-shot intent the upload provider will bind to.
   * The provider re-proves device, active slot, build record and private app bytes under the task's
   * own port lease, so a change after this point refuses the write instead of widening it.
   */
  async commitDeploy(options: { token: string; environment: string; port: string }): Promise<VerifiedDeployIntent> {
    const preview = this.preview;
    if (!preview || preview.token !== options.token) throw new Error("写入预览已失效，请重新核对写入目标");
    // One-shot immediately: a second click, a retry or another task has nothing to reuse.
    this.preview = null;
    this.writeIntent = null;
    this.activeIntent = null;
    // A hardware verdict belongs to the previous write; a new write starts without one.
    this.hardware = null;
    this.notify();
    if (this.running) throw new Error("固件验证正在运行，请先等待或取消");
    if (Date.parse(preview.expiresAt) <= Date.now()) throw new Error("写入预览已过期，请重新核对");
    if (this.options.unsaved?.()) throw new Error("工程有未保存的编辑，请先保存再烧录");
    const root = this.options.workspace.root;
    if (!root || path.resolve(root) !== path.resolve(preview.root)) throw new Error("工程目录已切换，请重新核对");
    const environment = typeof options.environment === "string" ? options.environment.trim() : "";
    if (environment !== preview.environment) throw new Error("构建环境已变化，请重新核对");
    const port = typeof options.port === "string" ? options.port.trim() : "";
    if (normalizePort(port) !== normalizePort(preview.port)) throw new Error("串口已变化，请重新核对");
    const evidence = this.evidence;
    if (!evidence || !evidence.passed || evidence.id !== preview.evidenceId) throw new Error("QEMU 证据已变化，请重新验证");
    if (evidence.appSha256 !== preview.appSha256 || evidence.environment !== preview.environment) throw new Error("QEMU 证据与预览不一致，请重新验证");
    const fingerprint = await this.options.workspace.fingerprint().catch(() => "");
    if (!fingerprint || fingerprint !== preview.inputHash) throw new Error("核对之后工程文件已变化，请重新验证");
    const intent: VerifiedDeployIntent = {
      id: randomUUID(), evidenceId: preview.evidenceId, root, environment, port,
      appSha256: preview.appSha256, inputHash: preview.inputHash, slot: preview.slot, erase: preview.erase,
    };
    this.writeIntent = intent;
    this.notify();
    return clone(intent);
  }

  cancel(): Promise<void> {
    if (this.running) this.cancelled = true;
    return this.simulator.cancel();
  }

  /**
   * Explicit stop path: close the retained hardware session (if any) and release its lease only once
   * the close is confirmed. Never frees a port on an unverified assumption.
   */
  async releaseHardware(): Promise<boolean> {
    const lease = this.hardwareLease;
    if (!lease) return true;
    const closed = await this.options.serial.dispose().then(() => true, () => !this.options.serial.isOpen());
    if (!closed) return false;
    deviceLease.release(lease);
    this.hardwareLease = null;
    return true;
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
    // A new run invalidates the deploy preview and any old record: both stop authorizing writes.
    this.preview = null;
    this.writeIntent = null;
    this.activeIntent = null;
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

  /**
   * The automatic task's post-write step. `runDevice` issues one challenge and closes the session;
   * this keeps ONE new session open instead: identity, a fresh challenge, twenty counter requests
   * and then the required quiet window all happen on that same transport under this lease. It is
   * bound to the exact upload task this round started, so a reused or earlier write cannot satisfy
   * it, and the port is only described as free when the close was verified.
   */
  async runStability(options: {
    port: string; taskId: string; transport?: FwValTransport; counts?: number; observeMs?: number;
    signal?: AbortSignal; onProgress?: (message: string) => void;
  }): Promise<StabilityEvidence> {
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录");
    const port = options.port?.trim();
    if (!port) throw new Error("请先明确选择实机串口");
    const taskId = options.taskId?.trim();
    if (!taskId) throw new Error("缺少本轮上传任务 ID；自动任务不接受按端口猜测的写入记录");
    const transport: FwValTransport = options.transport ?? "usb-serial-jtag";
    if (!["uart0", "usb-serial-jtag"].includes(transport)) throw new Error("实机挑战只支持 uart0 或 usb-serial-jtag");
    const counts = options.counts ?? 20;
    if (!Number.isInteger(counts) || counts < 20 || counts > 100) throw new Error("COUNT 次数必须是 20–100 的整数");
    const observeMs = options.observeMs ?? 60_000;
    if (!Number.isInteger(observeMs) || observeMs < 60_000 || observeMs > MAX_TIMEOUT) throw new Error("稳定观察必须至少 60000 毫秒");
    const qemu = this.evidence;
    if (!qemu || !qemu.passed) throw new Error("没有通过的 QEMU 验证记录；实机验证必须与同一镜像的仿真结果对比");
    if (path.resolve(root) !== path.resolve(qemu.root)) throw new Error("仿真记录属于另一个工程目录");
    if (this.running) throw new Error("固件验证已在运行，请先取消");

    // The deploy record must be THIS round's upload task, not the newest one on the port.
    const deploy = this.deployForTask(taskId, port);
    if (!deploy) throw new Error("本轮上传任务 " + taskId + " 不是该端口的成功 app-only 写入记录；不能绑定实机证据");
    if (deploy.appSha256.toLowerCase() !== qemu.appSha256.toLowerCase()) throw new Error("本轮写入的 app SHA 与当前 QEMU 证据不一致（写入 " + deploy.appSha256 + "，仿真 " + qemu.appSha256 + "）");
    if (deploy.environment !== qemu.environment) throw new Error("本轮写入的环境与当前 QEMU 证据不一致（写入 " + deploy.environment + "，仿真 " + qemu.environment + "）");
    const expectedFwid = qemu.identity.fwid;

    this.running = true;
    this.cancelled = false;
    this.error = "";
    this.notify();
    const token = freshToken();
    const runId = "device-" + randomUUID().slice(0, 8);
    const session = new FwValSession({ runId, transport, expectedFwid });
    const monitor = new FwValStabilityMonitor({ runId, expectedCounts: counts });
    let sessionId = 0;
    let issued = false;
    let helloSentAt = 0;
    let helloCount = 0;
    let lease: DeviceLeaseToken | null = null;
    let closeVerified = true;
    const closeSession = async () => {
      if (!sessionId) return true;
      // A close that throws is not evidence that the OS handle is gone; retry once, then keep the
      // lease so the port cannot be described as reusable.
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await this.options.serial.close(sessionId); return true; }
        catch { await wait(200); }
      }
      return false;
    };
    const startedAt = Date.now();
    const progress = (message: string) => { try { options.onProgress?.(message); } catch { /* progress must not break a run */ } };
    const aborted = () => this.cancelled || options.signal?.aborted === true;
    try {
      lease = deviceLease.claim("verification", port);
      this.hardwareLease = lease;
      sessionId = await this.options.serial.open(port, DEVICE_BAUD);
      this.priorSessions.push(sessionId);
      const send = async (text: string) => { await this.options.serial.write(sessionId, Array.from(Buffer.from(text, "utf8"))); };
      const sendHello = async () => { await send("HELLO\n"); helloSentAt = Date.now(); helloCount += 1; };
      await sendHello();
      const deadline = Date.now() + 30_000;
      // Phase 1: identity and one fresh challenge in this session.
      while (true) {
        if (aborted()) { session.disconnect("宿主已取消"); break; }
        const bytes = await this.options.serial.read(sessionId).catch((error) => { session.disconnect(String(error)); return [] as number[]; });
        if (bytes.length) session.feed(Uint8Array.from(bytes));
        if (session.currentPhase === "awaiting-ready" && helloCount < 2 && helloSentAt && Date.now() - helloSentAt > 1500) await sendHello();
        if (session.currentPhase === "ready" && !issued) {
          try { session.issueChallenge(token); await send("CHALLENGE token=" + token + "\n"); issued = true; } catch (error) { session.disconnect(String(error)); }
        }
        session.tick();
        if (session.currentPhase === "passed" || session.currentPhase === "failed") break;
        if (Date.now() > deadline) { session.disconnect("宿主硬超时"); break; }
        await wait(POLL_MS);
      }
      // Phase 2: twenty counter requests, then the quiet window, all in this same session.
      if (session.currentPhase === "passed") {
        progress("挑战已通过，开始 " + counts + " 次 COUNT");
        const countDeadline = Date.now() + counts * 6_000;
        let requested = 0;
        for (;;) {
          if (aborted()) break;
          const read = await this.options.serial.read(sessionId).catch(() => null);
          if (read === null) break;
          if (read.length) monitor.feed(Uint8Array.from(read));
          if (requested === counts && monitor.observed >= counts) break;
          if (monitor.observed === requested && requested < counts) { await send("COUNT\n"); monitor.request(); requested += 1; }
          monitor.tick();
          if (monitor.failure) break;
          if (Date.now() > countDeadline) break;
          await wait(POLL_MS);
        }
        if (monitor.observed < counts) progress("COUNT 未完成：" + monitor.observed + "/" + counts);
      }
      // No quiet window after a failed challenge: nothing more is proven by waiting, and the
      // session is closed instead of being kept open for a result that cannot change.
      const observeStart = Date.now();
      while (session.currentPhase === "passed" && observeStart + observeMs > Date.now()) {
        if (aborted()) break;
        const read = await this.options.serial.read(sessionId).catch(() => null);
        if (read === null) break;
        if (read.length) monitor.feed(Uint8Array.from(read));
        monitor.tick(observeMs);
        await wait(POLL_MS * 2);
      }
      const observedMs = Date.now() - observeStart;
      // The session must really close before the port can be described as reusable.
      closeVerified = await closeSession();
      const stability = monitor.finish();
      const challengePassed = session.currentPhase === "passed";
      const record = session.finish();
      const monitorEvidence: EspMonitorEvidence = {
        sessionId: String(sessionId), port, challenge: token, startedAt: new Date(startedAt).toISOString(),
        challengeObserved: issued && record.challenge?.token === token,
        outputObserved: stability.counts.length > 0,
      };
      const checked = verifyMonitorEvidence(deploy, monitorEvidence, { priorSessionIds: this.priorSessions.filter((item) => item !== sessionId).map(String) });
      const strictlyIncreasing = stability.strictlyIncreasing && stability.counts.length === counts && stability.failure === "";
      const passed = challengePassed && checked.ok && strictlyIncreasing && !stability.restartDetected && observedMs >= observeMs && closeVerified;
      const reason = !challengePassed ? (record.failure?.code ?? "挑战未通过")
        : !checked.ok ? checked.reason
        : !closeVerified ? "串口关闭未得到确认；端口不视为可重新使用"
        : stability.failure ? "COUNT 采样：" + stability.failure
        : stability.restartDetected ? "观察窗口内出现复位/看门狗：" + stability.restartMarkers.join(", ")
        : !strictlyIncreasing ? "COUNT 未连续递增（" + stability.counts.join(",") + "）"
        : observedMs < observeMs ? "观察窗口不足 " + observeMs + " 毫秒"
        : "";
      const evidence: StabilityEvidence = {
        version: 1, id: randomUUID(), passed,
        root, port, transport, environment: deploy.environment,
        taskId, appSha256: deploy.appSha256, planSha256: deploy.planSha256, sessionId,
        challenge: { token, passed: challengePassed, bound: checked.ok, reason: challengePassed ? "" : (record.failure?.code ?? "挑战未通过") },
        counts: stability.counts, observeMs, observedMs,
        strictlyIncreasing: stability.strictlyIncreasing,
        restartDetected: stability.restartDetected, restartMarkers: stability.restartMarkers,
        recordedAt: new Date().toISOString(), reason,
      };
      if (!passed) this.error = reason;
      this.notify();
      return clone(evidence);
    } finally {
      if (sessionId && closeVerified) closeVerified = await closeSession();
      if (closeVerified) {
        deviceLease.release(lease);
        this.hardwareLease = null;
      } else {
        // Keep the lease: without a confirmed close the port must not look free to the next entry.
        this.hardwareLease = lease;
        this.error = "串口关闭未得到确认；端口仍被视为占用。";
      }
      this.running = false;
    }
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

  /** The exact upload task this round started; an older or guessed record can never satisfy it. */
  private deployForTask(taskId: string, port: string): EspDeployRecord | null {
    const root = this.options.workspace.root;
    const task = this.options.tasks.list().find((item) => item.id === taskId);
    if (!task) return null;
    if (task.provider !== "esp.upload" || task.status !== "succeeded") return null;
    if (!root || task.root !== root) return null;
    if (normalizePort(String(task.options?.port ?? "")) !== normalizePort(port)) return null;
    const metadata = task.metadata as { simulation?: { appSha256?: string; planSha256?: string }; appOnly?: { mode?: string } } | undefined;
    if (!metadata?.appOnly || metadata.appOnly.mode !== "app-only") return null;
    const simulation = metadata.simulation;
    if (!simulation || !SHA256.test(String(simulation.appSha256 ?? "")) || !SHA256.test(String(simulation.planSha256 ?? ""))) return null;
    return { port, environment: task.environment ?? "", appSha256: String(simulation.appSha256), planSha256: String(simulation.planSha256), recordedAt: task.endedAt ?? task.startedAt };
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
}
