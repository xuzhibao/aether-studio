import { promises as fs } from "node:fs";
import path from "node:path";
import { deviceLease, normalizePort, type DeviceLeaseToken } from "./deviceLock";
import { findEsptool } from "./esp/esptool";
import { readDeviceFacts, usbDescriptorFor } from "./esp/inspect";
import { readEspProject } from "./esp/project";
import { VERIFIED_WRITE_OPTION, type FirmwareVerificationService } from "./simulator/verification";
import type { SerialService } from "./plugins/serial";
import type { TaskSnapshot } from "../shared/desktop";
import type { ToolService } from "./tools";
import type { WorkspaceService } from "./workspace";
import type { TaskService } from "./tasks";
import {
  isEditableFirmwareSource,
  type FirmwareDevSessionView,
  type FirmwareDevStage,
  type FirmwareDevStartOptions,
  type FirmwareDevStepView,
} from "../shared/firmwareDev";

// The automatic firmware-development task, host side.
//
// A trusted session is opened only by an explicit user start: it fixes the real project directory,
// the PlatformIO environment, the dedicated ESP32-C3 port and whether this run may write the active
// app slot and edit the existing firmware sources. Every later call is checked against that session
// and against a strict stage order; the model drives the steps, it can never describe, skip or widen
// one. The heavy work is delegated to the existing services (TaskService, FirmwareVerificationService,
// the same device lease, the same verified preview/commit path), so there is one write path only.

const ESP32C3_CHIP = /ESP32-C3/i;
const STAGE_ORDER: FirmwareDevStage[] = ["ready", "built", "simulated", "previewed", "written", "verified"];
const BUILD_TIMEOUT = 20 * 60_000;
const UPLOAD_TIMEOUT = 10 * 60_000;
const STABILITY_TIMEOUT = 6 * 60_000;
const MAX_EDIT_BYTES = 200_000;

const now = () => new Date().toISOString();
const sha256 = /^[0-9a-f]{64}$/i;

export interface FirmwareDevOptions {
  workspace: WorkspaceService;
  tasks: TaskService;
  tools: ToolService;
  serial: SerialService;
  verification: FirmwareVerificationService;
  /** A pending Flash restore plan was diffed against the pre-write device; the write invalidates it. */
  invalidateFlashPlan: () => void;
  /** True while the editor has unsaved buffers; every step must use the disk project. */
  unsaved: () => boolean;
  emit?: (view: FirmwareDevSessionView) => void;
}

interface Session {
  active: boolean;
  root: string;
  environment: string;
  port: string;
  /** Opaque handle of the board the user picked; every later device step must re-prove it. */
  deviceIdentity: string;
  appOnlyWriteAuthorized: boolean;
  sourceEditAuthorized: boolean;
  startedAt: string;
  cancelled: boolean;
  error: string;
}

const emptyView = (): FirmwareDevSessionView => ({
  active: false, stage: "ready", root: "", environment: "", port: "", device: null,
  appOnlyWriteAuthorized: false, sourceEditAuthorized: false,
  build: null, qemu: null, preview: null, write: null, challenge: null, stability: null,
  cancelled: false, error: "", startedAt: "", steps: [],
});

export class FirmwareDevService {
  private session: Session | null = null;
  private stage: FirmwareDevStage = "ready";
  private device: FirmwareDevSessionView["device"] = null;
  private buildInfo: FirmwareDevSessionView["build"] = null;
  private qemuInfo: FirmwareDevSessionView["qemu"] = null;
  private previewInfo: FirmwareDevSessionView["preview"] = null;
  /** One-shot host token for the previewed write; never part of the view handed to the renderer. */
  private previewToken = "";
  private writeInfo: FirmwareDevSessionView["write"] = null;
  private challengeInfo: FirmwareDevSessionView["challenge"] = null;
  private stabilityInfo: FirmwareDevSessionView["stability"] = null;
  private steps: FirmwareDevStepView[] = [];
  private busy = "";
  private signal = new AbortController();
  /** Cancels exactly this run's own device-re-proving task; never another task. */
  private writeAbort: AbortController | null = null;

  constructor(private options: FirmwareDevOptions) {}

  /** Every entry checks this: one host step at a time, never two device operations in parallel. */
  private enter(step: string): void {
    if (this.busy) throw new Error("自动任务正在执行 " + this.busy + "，请先等待或停止");
    this.busy = step;
    this.beginStep(step);
  }
  private leave(): void { this.busy = ""; }
  private beginStep(name: string): void {
    this.steps = [...this.steps, { name, status: "running", detail: "", startedAt: now() }];
    this.notify();
  }
  private endStep(status: FirmwareDevStepView["status"], detail: string): void {
    const timestamp = now();
    const last = this.steps[this.steps.length - 1];
    if (last && last.status === "running") this.steps = [...this.steps.slice(0, -1), { ...last, status, detail, endedAt: timestamp }];
    this.notify();
  }

  private notify() {
    try { this.options.emit?.(this.view()); } catch { /* a listener must not break a run */ }
  }

  view(): FirmwareDevSessionView {
    const session = this.session;
    return {
      ...emptyView(),
      active: !!session?.active,
      stage: this.stage,
      root: session?.root ?? "",
      environment: session?.environment ?? "",
      port: session?.port ?? "",
      device: this.device,
      appOnlyWriteAuthorized: !!session?.appOnlyWriteAuthorized,
      sourceEditAuthorized: !!session?.sourceEditAuthorized,
      build: this.buildInfo, qemu: this.qemuInfo, preview: this.previewInfo,
      write: this.writeInfo, challenge: this.challengeInfo, stability: this.stabilityInfo,
      cancelled: !!session?.cancelled,
      error: session?.error ?? "",
      startedAt: session?.startedAt ?? "",
      steps: this.steps.map((step) => ({ ...step })),
    };
  }

  /** Trusted start: pins the real project, environment and the dedicated board before any step. */
  async start(options: FirmwareDevStartOptions): Promise<FirmwareDevSessionView> {
    if (this.session?.active) throw new Error("自动任务已在进行；请先停止当前任务");
    if (options?.appOnlyWrite !== true || options?.sourceEdit !== true) throw new Error("开始自动固件任务需要同时确认：只写活动 app 槽、仅编辑既有固件源码");
    if (this.options.verification.status().running) throw new Error("固件验证正在运行，请先结束它");
    if (this.options.tasks.list().some((task) => task.status === "running")) throw new Error("已有构建/上传任务运行，请先等待或取消");
    if (this.options.serial.isOpen()) throw new Error("串口监视器仍占用端口，请先断开连接");
    const root = this.options.workspace.root;
    if (!root) throw new Error("请先打开工程目录，再开始自动固件任务");
    if (this.options.unsaved()) throw new Error("工程有未保存的编辑，请先保存再开始自动任务");
    const environment = typeof options.environment === "string" ? options.environment.trim() : "";
    if (!environment) throw new Error("请先选择 PlatformIO 环境");
    const port = typeof options.port === "string" ? options.port.trim() : "";
    if (!port) throw new Error("请先选择专用测试板串口");

    this.steps = [];
    let identity = "";
    this.enter("检查工程与设备");
    try {
      // The dedicated board is the long-term authorized one: native USB-Serial/JTAG 303A:1001.
      const usb = await usbDescriptorFor(port);
      const vendor = (usb?.vendorId ?? "").toLowerCase().replace(/^0x/, "");
      const product = (usb?.productId ?? "").toLowerCase().replace(/^0x/, "");
      if (vendor !== "303a" || product !== "1001") throw new Error("端口 " + port + " 不是已授权的 ESP32-C3 专用测试板（需要原生 USB-Serial/JTAG 303A:1001）；未开始任何步骤");
      const facts = await readEspProject(root, environment, this.options.tools.executable("platformio"), this.options.tools, this.options.workspace);
      if (!facts.supported) throw new Error(facts.skipped || "该工程不是 ESP 目标");
      if (facts.expectedId !== 5) throw new Error("工程构建目标不是 ESP32-C3（" + (facts.mcu || "未声明") + "）；本任务只支持 ESP32-C3");
      const found = await findEsptool(this.options.tools);
      if (!found.tool) throw new Error(found.reason || "找不到 esptool");
      let lease: DeviceLeaseToken | null = deviceLease.claim("verification", port);
      try {
        const device = await readDeviceFacts(found.tool, port);
        if (!device.ok) throw new Error("无法读取端口 " + port + " 上的设备：" + device.error);
        if (!ESP32C3_CHIP.test(device.chipName)) throw new Error("端口 " + port + " 上的芯片是 " + (device.chipName || "未知") + "，不是 ESP32-C3");
        // A COM name and a USB VID/PID do not name a board. The chip's own factory identity does, and
        // every later preview, write and physical challenge must re-prove this same handle.
        if (!device.identity) throw new Error("无法从芯片读到稳定的设备身份；不能确认用户选定的同一块板，未开始任何步骤");
        this.device = { chipName: device.chipName, revision: device.revision, flashSize: device.flashSize };
        identity = device.identity;
      } finally { deviceLease.release(lease); }
      this.session = {
        active: true, root, environment, port, deviceIdentity: identity, appOnlyWriteAuthorized: true, sourceEditAuthorized: true,
        startedAt: now(), cancelled: false, error: "",
      };
      this.stage = "ready";
      this.buildInfo = null; this.qemuInfo = null; this.previewInfo = null;
      this.writeInfo = null; this.challengeInfo = null; this.stabilityInfo = null;
      this.signal = new AbortController();
      this.endStep("succeeded", deviceSummary(this.device));
      return this.view();
    } catch (error) {
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.leave(); }
  }

  private requireSession(): Session {
    const session = this.session;
    if (!session?.active) throw new Error("自动任务没有进行中的可信会话；请先开始任务");
    if (session.cancelled) throw new Error("自动任务已取消，不会继续执行后续步骤");
    return session;
  }

  private requireStage(expected: FirmwareDevStage): Session {
    const session = this.requireSession();
    if (this.stage !== expected) throw new Error("步骤顺序不符：当前阶段 " + this.stage + "，此操作需要 " + expected);
    return session;
  }

  /** Real PlatformIO build; rebuilding after QEMU evidence would change the image and is refused. */
  async build(): Promise<FirmwareDevSessionView> {
    const session = this.requireStage("ready");
    if (this.options.unsaved()) throw new Error("工程有未保存的编辑，请先保存再构建");
    if (this.options.verification.status().preview) throw new Error("存在未使用的写入预览，请先停止并重新开始");
    this.enter("真实构建");
    try {
      const task = await this.options.tasks.start("platformio.build", { environment: session.environment });
      const settled = await this.waitTask(task.id, BUILD_TIMEOUT);
      if (settled.status !== "succeeded") throw new Error("构建未通过（" + settled.status + "）：" + (settled.error || "见 Build Tasks 日志"));
      const app = settled.artifacts.find((item) => item.path.endsWith("/firmware.bin"));
      if (!app || !sha256.test(app.sha256)) throw new Error("构建成功但没有登记 firmware.bin 产物");
      const record = await this.buildRecord(app.sha256);
      this.buildInfo = { taskId: settled.id, appSha256: app.sha256, inputHash: record, firmwareBytes: app.size };
      this.stage = "built";
      this.endStep("succeeded", "app " + short(app.sha256) + " · " + app.size + " 字节");
      return this.view();
    } catch (error) {
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.leave(); }
  }

  /** Two independent QEMU boots with fresh challenges; the record is host-owned. */
  async simulate(): Promise<FirmwareDevSessionView> {
    const session = this.requireStage("built");
    this.enter("QEMU 验证");
    try {
      const evidence = await this.options.verification.runSimulation({ environment: session.environment, boots: 2, timeoutMs: 60_000 });
      if (!evidence.passed) throw new Error("QEMU 验证未通过：" + (evidence.error || "见固件验证面板记录"));
      if (evidence.root !== session.root) throw new Error("QEMU 记录属于另一个工程目录");
      if (evidence.appSha256.toLowerCase() !== this.buildInfo?.appSha256.toLowerCase()) throw new Error("QEMU 记录与本次构建的 app 不一致");
      if (evidence.inputHash !== this.buildInfo?.inputHash) throw new Error("构建后工程文件又发生变化，请重新开始任务");
      this.qemuInfo = { evidenceId: evidence.id, appSha256: evidence.appSha256, boots: evidence.boots.length, fwid: evidence.identity.fwid, recordedAt: evidence.recordedAt };
      this.stage = "simulated";
      this.endStep("succeeded", "证据 " + evidence.id.slice(0, 8) + " · " + evidence.boots.length + " 次启动");
      return this.view();
    } catch (error) {
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.leave(); }
  }

  /** Read-only preflight: re-proves device, active slot, build record and the exact app bytes. */
  async preview(): Promise<FirmwareDevSessionView> {
    const session = this.requireStage("simulated");
    if (this.options.verification.status().preview) throw new Error("已有写入预览，请先停止并重新开始");
    this.enter("核对写入范围");
    try {
      const preview = await this.options.verification.previewDeploy({ environment: session.environment, port: session.port });
      if (preview.appSha256.toLowerCase() !== this.qemuInfo?.appSha256.toLowerCase()) throw new Error("预览的 app 与 QEMU 记录不一致");
      // The board that will be written must be the one the user picked when this task started.
      if (!session.deviceIdentity || preview.device.identity !== session.deviceIdentity) throw new Error("端口 " + session.port + " 上现在不是用户选定的那块测试板；已拒绝；未写入任何数据");
      this.previewToken = preview.token;
      this.previewInfo = { appSha256: preview.appSha256, slot: preview.slot, erase: preview.erase, expiresAt: preview.expiresAt };
      this.stage = "previewed";
      this.endStep("succeeded", "槽 " + preview.slot.label + " · 擦除 " + preview.erase.size + " 字节");
      return this.view();
    } catch (error) {
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.leave(); }
  }

  /** The single app-only write of this run: the one-shot host intent, no rebuild, no retry. */
  async write(): Promise<FirmwareDevSessionView> {
    const session = this.requireStage("previewed");
    if (!session.appOnlyWriteAuthorized) throw new Error("本次任务没有 app-only 写入授权");
    if (!this.previewInfo || !this.previewToken || Date.parse(this.previewInfo.expiresAt) <= Date.now()) throw new Error("写入预览已过期，请重新开始任务");
    this.enter("app-only 写入");
    this.options.invalidateFlashPlan();
    // Claim before any await so a monitor opening the port cannot slip between the checks.
    const token = deviceLease.claim("task");
    // This run's own cancellation: it reaches the task's device re-proof, not just this handler.
    const writeAbort = new AbortController();
    this.writeAbort = writeAbort;
    const cancelled = () => session.cancelled || this.session !== session || this.signal.signal.aborted;
    // True only while THIS handler still owns the lease; the task takes it over once it starts.
    let leaseOwned = true;
    try {
      const tokenValue = this.previewToken;
      this.previewToken = "";
      const intent = await this.options.verification.commitDeploy({ token: tokenValue, environment: session.environment, port: session.port });
      // commitDeploy awaited (workspace fingerprint): the session may have stopped meanwhile. Re-check
      // before the task exists, and withdraw the one-shot intent that has not reached the uploader yet.
      if (cancelled()) {
        this.options.verification.abortWrite(intent.id);
        throw new Error("自动任务已停止，已撤销尚未开始的写入意图；未写入任何数据");
      }
      let task: TaskSnapshot;
      try {
        task = await this.options.tasks.start("esp.upload", { port: intent.port, environment: intent.environment, [VERIFIED_WRITE_OPTION]: intent.id }, token, writeAbort.signal);
        leaseOwned = false;
      } catch (error) {
        // A refusal before a process exists has no write to settle; the one-shot intent is dropped.
        this.options.verification.abortWrite(intent.id);
        throw error;
      }
      // From here the process exists: the write may have started. Never claim a rollback.
      this.writeInfo = { taskId: task.id, status: task.status, appSha256: intent.appSha256, planSha256: "", started: true };
      this.notify();
      const settled = await this.waitTask(task.id, UPLOAD_TIMEOUT);
      const metadata = settled.metadata as {
        simulation?: { appSha256?: string; planSha256?: string };
        writeCheck?: { ok?: boolean; problems?: string[] };
      } | undefined;
      const appSha256 = String(metadata?.simulation?.appSha256 ?? "");
      const planSha256 = String(metadata?.simulation?.planSha256 ?? "");
      // Exit code 0 only says esptool finished. This says the command it ran is the single app-only
      // segment that was planned and each of those hashes was verified — without it nothing downstream counts.
      const writeCheck = metadata?.writeCheck;
      const writeProven = writeCheck?.ok === true;
      this.writeInfo = { taskId: settled.id, status: settled.status, appSha256: appSha256 || intent.appSha256, planSha256, started: true };
      if (settled.status !== "succeeded") {
        const detail = settled.status === "cancelled"
          ? "写入已取消；若已开始擦写，设备上的 app 可能不完整，不会自动回滚"
          : "写入任务失败，可能已发生部分写入；不会自动重试或回滚，请核对设备后重新开始";
        throw new Error(detail);
      }
      if (!writeProven) {
        const problems = Array.isArray(writeCheck?.problems) ? writeCheck!.problems!.filter(Boolean).join("；") : "上传记录缺少实际写入命令核对结果";
        throw new Error("进程已退出但实际写入的段/命令未通过核对（" + problems + "）；不能视为 app-only 写入成功，不能进入实机验证");
      }
      if (!sha256.test(appSha256) || appSha256.toLowerCase() !== this.qemuInfo?.appSha256.toLowerCase()) throw new Error("写入记录的 app 与 QEMU 证据不一致；不能继续实机验证");
      if (!sha256.test(planSha256)) throw new Error("写入记录缺少部署计划摘要；不能绑定实机验证");
      this.stage = "written";
      this.endStep("succeeded", "任务 " + settled.id.slice(0, 8) + " · app-only 单段已核对");
      return this.view();
    } catch (error) {
      // A refusal or a withdrawn intent never handed the lease to a task; free exactly this token
      // (a stale token is a no-op, so a later owner can never be released here).
      if (leaseOwned) deviceLease.release(token);
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.writeAbort = null; this.leave(); }
  }

  /** New physical session on the written port: challenge, 20 COUNTs and the quiet window. */
  async challenge(): Promise<FirmwareDevSessionView> {
    const session = this.requireStage("written");
    const write = this.writeInfo;
    if (!write?.taskId || !write.started) throw new Error("本轮没有实际开始的写入任务，不能进入实机验证");
    this.enter("实机验证");
    try {
      const evidence = await this.options.verification.runStability({
        port: session.port, taskId: write.taskId, transport: "usb-serial-jtag",
        counts: 20, observeMs: 60_000, signal: this.signal.signal,
        onProgress: (message) => this.endStepDetail(message),
      });
      this.challengeInfo = { evidenceId: evidence.id, passed: evidence.challenge.passed && evidence.challenge.bound, bound: evidence.challenge.bound, sessionId: evidence.sessionId };
      this.stabilityInfo = {
        counts: evidence.counts, postWindowCount: evidence.postWindowCount, observeMs: evidence.observeMs, observedMs: evidence.observedMs,
        strictlyIncreasing: evidence.strictlyIncreasing, restartDetected: evidence.restartDetected,
        watchdogLines: evidence.restartMarkers, failures: evidence.reason ? [evidence.reason] : [],
      };
      if (!evidence.passed) throw new Error("实机验证未通过：" + (evidence.reason || "见会话记录"));
      this.stage = "verified";
      this.endStep("succeeded", evidence.counts.length + " 次 COUNT 严格递增 · 观察 " + Math.round(evidence.observedMs / 1000) + " 秒无看门狗/重启");
      return this.view();
    } catch (error) {
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.leave(); }
  }

  /**
   * The automatic task's real edit of ONE existing in-scope firmware source.
   *
   * The host — not the renderer — owns every check and the write itself: this run's session and its
   * pinned project, the file scope, the exact disk text the change was based on, no unsaved buffer,
   * no running task, no cancellation/project switch, an ordinary in-tree file (no symlink/junction on
   * any path segment, not reserved, not a tool cache), and that the target already exists. Only edits
   * made before this round's build are accepted, so the built image always contains them.
   * The ordinary review flow for other agents is untouched.
   */
  async applyEdit(options: { path: string; expected: string; content: string }): Promise<{ path: string; before: string; after: string }> {
    const session = this.requireSession();
    if (!session.sourceEditAuthorized) throw new Error("本次任务没有源码编辑授权");
    // Fail fast while another host step runs; the authoritative serialization is enter() below.
    if (this.busy) throw new Error("自动任务正在执行 " + this.busy + "，不能同时修改源码");
    if (this.stage !== "ready") throw new Error("本轮已完成构建；源码修改必须发生在构建之前。请停止并重新开始任务");
    if (this.options.tasks.list().some((task) => task.status === "running")) throw new Error("构建/上传任务运行中，不能修改源码");
    if (this.options.workspace.root !== session.root) throw new Error("工程目录已切换，自动任务不再授权任何修改");
    const name = typeof options.path === "string" ? options.path.trim() : "";
    if (!isEditableFirmwareSource(name)) throw new Error("超出本次授权的文件：" + (name || "空路径") + "（只允许既有固件源码 src/ 或 main/ 下的 .c/.h/.cpp/.hpp）");
    if (typeof options.content !== "string" || options.content.length === 0 || options.content.length > MAX_EDIT_BYTES) throw new Error("修改内容为空或过大");
    if (this.options.unsaved()) throw new Error("工程有未保存的编辑；请先保存，避免覆盖未落盘的内容");
    const target = path.join(session.root, ...name.split("/"));
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error("不是工程内的普通文件，不能修改：" + name);
    const current = await fs.readFile(target, "utf8").catch(() => null);
    if (current === null) throw new Error("不是既有固件源码，不能新建：" + name);
    if (current !== options.expected) throw new Error(name + " 在生成修改后已被修改（磁盘内容与预览前提不一致），拒绝覆盖");
    if (current === options.content) throw new Error("修改内容与磁盘一致，无需写入");
    // Serialize with every other host step: a build or a second edit cannot start while this write
    // runs, and this write cannot start while one of them is running.
    this.enter("修改固件源码");
    try {
      // The last check, re-run by the workspace immediately before the rename commits the new text
      // (including Windows rename retries): stop, project switch or a newly unsaved buffer refuses.
      const guard = () => {
        if (session.cancelled || this.session !== session) throw new Error("自动任务已停止，修改未写入");
        if (this.stage !== "ready") throw new Error("本轮已进入构建之后阶段，修改未写入");
        if (this.options.unsaved()) throw new Error("工程有未保存的编辑；修改未写入");
      };
      guard();
      await this.options.workspace.writeExisting(name, options.content, options.expected, guard);
      this.endStep("succeeded", name + " · " + options.content.length + " 字节");
      return { path: name, before: current, after: options.content };
    } catch (error) {
      this.endStep("failed", String(error instanceof Error ? error.message : error));
      throw error;
    } finally { this.leave(); }
  }

  /** Stop is reachable from any stage and never queues behind the step it cancels. */
  async stop(): Promise<FirmwareDevSessionView> {
    const session = this.session;
    if (!session?.active) return this.view();
    session.cancelled = true;
    this.signal.abort(new Error("宿主已取消"));
    // A write still re-proving the device stops here, before a write_flash process can exist.
    this.writeAbort?.abort(new Error("宿主已取消"));
    // The bounded wait is on the real process/lease, not on this handler's own queue.
    await this.options.verification.cancel().catch(() => {});
    // A retained hardware session without a confirmed close keeps its lease; retry the close here.
    await this.options.verification.releaseHardware().catch(() => false);
    const running = this.options.tasks.list().filter((task) => task.status === "running");
    await Promise.all(running.map((task) => this.options.tasks.cancel(task.id).catch(() => {})));
    // Wait for the step that was really running to settle (bounded), so the reported state is the
    // settled one: a still-running step keeps its own process/lease truthfully.
    const deadline = Date.now() + 20_000;
    while (this.busy && Date.now() < deadline) await wait(200);
    const last = this.steps[this.steps.length - 1];
    if (last?.status === "running") this.endStep(this.busy ? "failed" : "cancelled", this.busy ? "取消后 " + this.busy + " 仍未结算；请检查真实进程与端口" : "已停止；真实进程/租约已结算");
    session.active = false;
    this.notify();
    return this.view();
  }

  /** Project switch or app quit: the session must not survive and authorize anything later. */
  async dispose(): Promise<void> {
    await this.stop().catch(() => {});
    // A finished run must not leave an unused one-shot write intent behind.
    try { this.options.verification.disarm(); } catch { /* nothing to disarm */ }
    this.session = null;
    this.stage = "ready";
    this.device = null;
    this.buildInfo = null; this.qemuInfo = null; this.previewInfo = null; this.previewToken = "";
    this.writeInfo = null; this.challengeInfo = null; this.stabilityInfo = null;
    this.steps = [];
    this.busy = "";
    this.notify();
  }

  private endStepDetail(detail: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last?.status === "running") this.steps = [...this.steps.slice(0, -1), { ...last, detail }];
    this.notify();
  }

  private async waitTask(id: string, timeoutMs: number): Promise<TaskSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.session?.cancelled) {
        // The stop path already asked TaskService to cancel; report the settled snapshot.
        const settled = this.options.tasks.list().find((task) => task.id === id);
        if (settled && settled.status !== "running") return settled;
      }
      const task = this.options.tasks.list().find((item) => item.id === id);
      if (!task) throw new Error("任务消失：" + id);
      if (task.status !== "running") return task;
      if (Date.now() > deadline) throw new Error("等待真实进程结束超时：" + id + "；不会自动重试写入");
      await wait(500);
    }
  }

  /** The project input fingerprint recorded by this build, compared byte-for-byte later. */
  private async buildRecord(appSha256: string): Promise<string> {
    try {
      const record = JSON.parse(await fs.readFile(path.join(this.session!.root, ".aether", "build.json"), "utf8")) as { inputHash?: string; artifacts?: { path: string; sha256: string }[] };
      const app = record.artifacts?.find((item) => item.path.endsWith("/firmware.bin"));
      if (app && app.sha256.toLowerCase() === appSha256.toLowerCase() && typeof record.inputHash === "string") return record.inputHash;
    } catch { /* fall through */ }
    throw new Error("构建记录缺少与本轮 app 匹配的输入指纹");
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (value: string) => (value.length > 12 ? value.slice(0, 12) + "…" : value);
const deviceSummary = (device: FirmwareDevSessionView["device"]) =>
  device ? device.chipName + " rev " + (device.revision || "?") + (device.flashSize ? " · " + device.flashSize / 1048576 + " MB" : "") : "未读取设备";

/** Exported for the stage-order contract test. */
export const firmwareDevStageOrder = STAGE_ORDER;
export const normalizeFirmwareDevPort = normalizePort;
