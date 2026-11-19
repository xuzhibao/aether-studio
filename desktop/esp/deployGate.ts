import { createHash } from "node:crypto";
import path from "node:path";
import type { EspPlannedSegment } from "../../shared/esp";

// The optional host-side gate between a verified deploy plan and the single esptool write path.
// Everything here is pure: the provider decides where the evidence comes from (a host-owned file or a
// host-side verifier); the renderer has no IPC parameter that can produce or bypass it. The gate never
// builds an argv and never writes flash, so a refusal is always zero writes.

/** A QEMU simulation result as the host knows it. Never accept one that came from the renderer. */
export interface EspSimulationEvidence {
  /** Format version; an unknown version is refused instead of being read optimistically. */
  version: 1;
  /** Only a passed simulation can authorise a write. */
  passed: boolean;
  /** SHA-256 of the app image the simulation actually ran; must equal the bytes about to be written. */
  appSha256: string;
  /** The PlatformIO environment that was simulated. */
  environment: string;
  /** Project input fingerprint at simulation time (optional); when present it must still match. */
  inputHash?: string;
  /** ISO 8601 timestamp, used for audit and ordering only. */
  recordedAt: string;
  /** Where the record came from (for example a QEMU session id); audit only. */
  source: string;
}

/** What the deploy is about to do, derived from the private snapshot rather than from the workspace. */
export interface EspDeployExpectation {
  port: string;
  environment: string;
  /** SHA-256 of the exact app bytes in the private input snapshot. */
  appSha256: string;
  /** Project fingerprint re-read at gate time, so a project/env/source switch is visible. */
  inputHash: string;
}

export type EspSimulationVerdict = { allowed: true; evidence: EspSimulationEvidence } | { allowed: false; reason: string };

export interface EspSimulationGate {
  /** Evaluated on every deploy; the host can require the gate per project and change its mind later. */
  required: () => boolean | Promise<boolean>;
  /** Reads the newest host-trusted record. Must never be wired to renderer input. */
  evidence: () => Promise<EspSimulationEvidence | null>;
  /** Optional host verifier (signatures, external store). Defaults to the strict comparison below. */
  verify?: (evidence: EspSimulationEvidence | null, expected: EspDeployExpectation) => EspSimulationVerdict | Promise<EspSimulationVerdict>;
}

export interface EspSnapshotEntry { name: string; file: string; size: number; sha256: string }

const SHA256 = /^[0-9a-f]{64}$/;

const failure = (reason: string): EspSimulationVerdict => ({ allowed: false, reason });

/**
 * Binds the gate to the private snapshot: the app segment must be unique, and the snapshot the upload
 * will actually hand to esptool must carry exactly the planned size and SHA-256. A rebuilt, replaced or
 * switched artifact fails here even when every earlier check passed.
 */
export function bindDeployExpectation(plan: {
  port: string; environment: string; inputHash: string;
  segments: EspPlannedSegment[]; snapshots: EspSnapshotEntry[];
}): EspDeployExpectation {
  const apps = plan.segments.filter((segment) => segment.name === "app");
  if (apps.length !== 1) throw new Error("写入计划中 app 段不是恰好一段（" + apps.length + "），无法绑定仿真证据。未写入任何数据。");
  const app = apps[0];
  const name = path.basename(app.file);
  const snapshot = plan.snapshots.filter((file) => file.name === name);
  if (snapshot.length !== 1) throw new Error("私有快照中没有唯一的 " + name + "，无法绑定仿真证据。未写入任何数据。");
  if (snapshot[0].size !== app.size || snapshot[0].sha256 !== app.sha256) {
    throw new Error("私有快照中的 " + name + " 与写入计划不一致（快照 " + snapshot[0].size + " 字节 / " + snapshot[0].sha256 + "，计划 " + app.size + " 字节 / " + app.sha256 + "）。未写入任何数据。");
  }
  if (!SHA256.test(app.sha256)) throw new Error("app 段的 SHA-256 无效，无法绑定仿真证据。未写入任何数据。");
  if (!plan.inputHash) throw new Error("无法读取工程输入指纹，无法绑定仿真证据。未写入任何数据。");
  return { port: plan.port.trim(), environment: plan.environment.trim(), appSha256: app.sha256.toLowerCase(), inputHash: plan.inputHash };
}

/** Strict default: a passed, current, same-environment record for exactly these app bytes. */
export function verifySimulationEvidence(evidence: EspSimulationEvidence | null, expected: EspDeployExpectation): EspSimulationVerdict {
  if (!evidence) return failure("没有任何仿真通过记录");
  if (evidence.version !== 1) return failure("仿真证据格式版本不受支持（" + String(evidence.version) + "）");
  if (evidence.passed !== true) return failure("最近一次仿真没有通过");
  const appSha256 = String(evidence.appSha256 ?? "").toLowerCase();
  if (!SHA256.test(appSha256)) return failure("仿真记录里的 app SHA-256 无效");
  if (appSha256 !== expected.appSha256) return failure("仿真过的 app 镜像与将要写入的不一致（仿真 " + appSha256 + "，写入 " + expected.appSha256 + "）");
  if (String(evidence.environment ?? "").trim() !== expected.environment) return failure("仿真记录属于环境 " + (evidence.environment || "未记录") + "，不是 " + expected.environment);
  if (evidence.inputHash) {
    if (String(evidence.inputHash).toLowerCase() !== expected.inputHash.toLowerCase()) return failure("仿真之后工程文件又发生了变化");
  }
  if (!Number.isFinite(Date.parse(String(evidence.recordedAt ?? "")))) return failure("仿真记录缺少可解析的时间");
  return { allowed: true, evidence };
}

/**
 * Runs the gate while the port lease is held and before the esptool process exists. `required` is
 * evaluated once; the expectation (snapshot binding plus a fresh project fingerprint) is only built
 * when it is true. Returns the accepted record, or null when this deploy does not require one.
 * A thrown error cancels the task, so zero bytes reach flash.
 */
export async function enforceSimulationGate(gate: EspSimulationGate, expectation: () => Promise<EspDeployExpectation>, log: (line: string) => void): Promise<EspSimulationEvidence | null> {
  if (!(await gate.required())) return null;
  const expected = await expectation();
  let evidence: EspSimulationEvidence | null;
  try { evidence = await gate.evidence(); }
  catch (error) { throw new Error("无法读取仿真证据：" + (error instanceof Error ? error.message : String(error)) + "。未写入任何数据。"); }
  let verdict: EspSimulationVerdict;
  try { verdict = gate.verify ? await gate.verify(evidence, expected) : verifySimulationEvidence(evidence, expected); }
  catch (error) { throw new Error("仿真证据校验失败：" + (error instanceof Error ? error.message : String(error)) + "。未写入任何数据。"); }
  if (!verdict.allowed) throw new Error("该工程要求先通过仿真，但当前证据不足以放行：" + verdict.reason + "。未写入任何数据。");
  log("[aether] 仿真证据已绑定 app " + expected.appSha256 + "（env " + expected.environment + "，来源 " + (verdict.evidence.source || "未记录") + "，记录于 " + verdict.evidence.recordedAt + "）");
  return verdict.evidence;
}

// ---------------------------------------------------------------------------------------------
// Real-run evidence binding for the post-deploy monitor stage.
//
// A successful upload only proves that esptool exited 0. The board is considered running only when a
// NEW serial session on the SAME port shows the deployed plan digest AND a host-generated challenge.
// D owns the session/status/IPC; these helpers define the values that must be bound so the page cannot
// substitute an exit code for an observed run.
// ---------------------------------------------------------------------------------------------

/** The deploy record D must carry forward; planSha256 is the binding value, not the exit code. */
export interface EspDeployRecord {
  port: string;
  environment: string;
  appSha256: string;
  planSha256: string;
  recordedAt: string;
}

/** Digest over the exact write plan (names, offsets, sizes, image SHA-256) plus port and environment. */
export function deploymentPlanDigest(port: string, environment: string, segments: Array<Pick<EspPlannedSegment, "name" | "offset" | "size" | "sha256">>): string {
  const normalized = segments
    .map((segment) => [segment.name, segment.offset, segment.size, segment.sha256.toLowerCase()].join(":"))
    .sort()
    .join("|");
  return createHash("sha256").update(JSON.stringify({ version: 1, port: port.trim().toUpperCase(), environment: environment.trim(), segments: normalized })).digest("hex");
}

export interface EspMonitorEvidence {
  /** A session opened after the deploy; reusing an earlier session is refused. */
  sessionId: string;
  port: string;
  /** Host-generated challenge; it must have been observed in this session output. */
  challenge: string;
  startedAt: string;
  /** True only when the challenge appeared in the session output. */
  challengeObserved: boolean;
  /** True only when real runtime output was observed (never the upload log). */
  outputObserved: boolean;
}

/**
 * Validates the binding only. It deliberately ignores upload exit codes: passing this check says the
 * evidence is well-formed and bound, not that D may skip its own observation.
 */
export function verifyMonitorEvidence(plan: EspDeployRecord, evidence: EspMonitorEvidence, options: { priorSessionIds?: string[] } = {}): { ok: true } | { ok: false; reason: string } {
  if (!SHA256.test(String(plan.planSha256 ?? "").toLowerCase())) return { ok: false, reason: "部署记录缺少有效的计划摘要" };
  if (!SHA256.test(String(plan.appSha256 ?? "").toLowerCase())) return { ok: false, reason: "部署记录缺少有效的 app SHA-256" };
  if (!Number.isFinite(Date.parse(String(plan.recordedAt ?? "")))) return { ok: false, reason: "部署记录缺少可解析的时间" };
  const sessionId = String(evidence.sessionId ?? "").trim();
  if (!sessionId) return { ok: false, reason: "监视会话没有 ID" };
  if ((options.priorSessionIds ?? []).some((prior) => prior.trim() === sessionId)) return { ok: false, reason: "监视会话不是部署后新开的（复用了旧会话 " + sessionId + "）" };
  if (String(evidence.port ?? "").trim().toUpperCase() !== String(plan.port ?? "").trim().toUpperCase()) return { ok: false, reason: "监视端口与部署端口不一致" };
  if (!String(evidence.challenge ?? "").trim()) return { ok: false, reason: "缺少宿主随机挑战" };
  if (evidence.challengeObserved !== true) return { ok: false, reason: "没有在会话输出中观察到随机挑战" };
  if (evidence.outputObserved !== true) return { ok: false, reason: "没有观察到运行期输出" };
  const started = Date.parse(String(evidence.startedAt ?? ""));
  if (!Number.isFinite(started)) return { ok: false, reason: "监视会话缺少可解析的开始时间" };
  if (started < Date.parse(plan.recordedAt)) return { ok: false, reason: "监视会话早于本次部署" };
  return { ok: true };
}
