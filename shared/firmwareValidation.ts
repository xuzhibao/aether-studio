// Shared pure contract for the ESP32-C3 firmware-validation example.
//
// No filesystem, no child process, no timers: the host feeds bytes, timestamps and
// a fresh random token, and this module decides whether the round-trip actually
// passed. A mismatched value, a stale token, a timeout or a disconnect is recorded
// as a failure — never as a pass. Virtual (QEMU) and real (hardware) runs share the
// same rules and differ only in the `transport`/`evidence` fields of the record.

export const FWVAL_PROTOCOL = "AETHER-VAL/1";
export const FWVAL_MAX_LINE = 512;
/** Every protocol line, both directions, is bounded to this many bytes. */
export const FWVAL_PROTOCOL_MAX_LINE = 128;
export const FWVAL_TOKEN_PATTERN = /^[0-9a-f]{16}$/;
export const FWVAL_READY_TIMEOUT_MS = 15_000;
export const FWVAL_CHALLENGE_TIMEOUT_MS = 5_000;

/** Where the bytes came from. QEMU is always UART0; hardware may be either port. */
export type FwValTransport = "qemu-uart0" | "uart0" | "usb-serial-jtag";
/** Evidence class. The host records which one a run actually produced. */
export type FwValEvidence = "virtual" | "hardware";

export type FwValPhase = "awaiting-ready" | "ready" | "challenge-issued" | "passed" | "failed";

export type FwValFailureCode =
  | "ready-timeout"
  | "response-timeout"
  | "disconnected"
  | "protocol-error"
  | "line-too-long"
  | "response-before-ready"
  | "reboot-detected"
  | "stale-token"
  | "value-mismatch"
  | "fwid-mismatch"
  | "bad-token"
  | "device-error";

export interface FwValDeviceIdentity {
  fwid: string;
  proto: string;
  soc: string;
  console: string;
}

export interface FwValResponse {
  token: string;
  value: string;
  fwid: string;
}

export interface FwValFailure {
  code: FwValFailureCode;
  detail: string;
}

/** Everything a run must keep so A/C/D can tell a real pass from a coincidence. */
export interface FwValRecord {
  protocol: string;
  runId: string;
  transport: FwValTransport;
  evidence: FwValEvidence;
  phase: FwValPhase;
  verdict: "pass" | "fail" | "incomplete";
  startedAtMs: number;
  finishedAtMs: number | null;
  challenge: { token: string; issuedAtMs: number } | null;
  device: FwValDeviceIdentity | null;
  response: FwValResponse | null;
  expectedValue: string | null;
  /** Console channels that announced the same firmware identity in this run. */
  consoles: string[];
  failure: FwValFailure | null;
  bytesIn: number;
  linesSeen: number;
  ignoredLines: number;
}

/** FNV-1a 32-bit over the ASCII bytes of `input`. Mirrors fwval_fnv1a32 in firmware. */
export function fwvalFnv1a32(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ (input.charCodeAt(i) & 0xff)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic challenge answer, 8 lowercase hex characters. Mirrors fwval_answer. */
export function fwvalAnswer(token: string, fwid: string): string {
  let x = (fwvalFnv1a32(token) ^ fwvalFnv1a32(fwid)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x.toString(16).padStart(8, "0");
}

export interface FwValSessionOptions {
  runId: string;
  transport: FwValTransport;
  /** Pin the expected firmware identity; any other `fw=` value fails the run. */
  expectedFwid?: string;
  readyTimeoutMs?: number;
  challengeTimeoutMs?: number;
  now?: () => number;
}

const evidenceFor = (transport: FwValTransport): FwValEvidence =>
  transport === "qemu-uart0" ? "virtual" : "hardware";

interface ReadyLine {
  fwid: string;
  proto: string;
  soc: string;
  console: string;
}

function parseFields(line: string): { verb: string; fields: Record<string, string> } | null {
  const parts = line.split(" ");
  if (parts.length < 2 || parts[0] !== FWVAL_PROTOCOL) return null;
  const fields: Record<string, string> = {};
  for (const part of parts.slice(2)) {
    const eq = part.indexOf("=");
    if (eq <= 0 || eq === part.length - 1) return null;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { verb: parts[1], fields };
}

/**
 * One validation run. Feed raw serial bytes with one or many lines per chunk;
 * partial lines are buffered. The caller owns the clock and the random token.
 */
export class FwValSession {
  private readonly runId: string;
  private readonly transport: FwValTransport;
  private readonly expectedFwid: string | undefined;
  private readonly readyTimeoutMs: number;
  private readonly challengeTimeoutMs: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;

  private phase: FwValPhase = "awaiting-ready";
  private finishedAtMs: number | null = null;
  private challenge: { token: string; issuedAtMs: number } | null = null;
  private device: FwValDeviceIdentity | null = null;
  private response: FwValResponse | null = null;
  private expectedValue: string | null = null;
  private failure: FwValFailure | null = null;

  private bytesIn = 0;
  private linesSeen = 0;
  private ignoredLines = 0;
  private consoles: string[] = [];

  private lineBytes: number[] = [];
  private lineOverflow = false;

  constructor(options: FwValSessionOptions) {
    this.runId = options.runId;
    this.transport = options.transport;
    this.expectedFwid = options.expectedFwid;
    this.readyTimeoutMs = options.readyTimeoutMs ?? FWVAL_READY_TIMEOUT_MS;
    this.challengeTimeoutMs = options.challengeTimeoutMs ?? FWVAL_CHALLENGE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.startedAtMs = this.now();
  }

  get currentPhase(): FwValPhase {
    return this.phase;
  }

  get passed(): boolean {
    return this.phase === "passed";
  }

  /** Issues the fresh challenge. Only valid after READY and before any verdict. */
  issueChallenge(token: string): void {
    if (this.phase !== "ready") {
      throw new Error(`challenge issued in phase ${this.phase}`);
    }
    if (!FWVAL_TOKEN_PATTERN.test(token)) {
      throw new Error("challenge token must be 16 lowercase hex characters");
    }
    this.challenge = { token, issuedAtMs: this.now() };
    this.expectedValue = fwvalAnswer(token, this.device?.fwid ?? "");
    this.phase = "challenge-issued";
  }

  /** Feeds raw bytes; returns the lines that completed during this chunk. */
  feed(chunk: Uint8Array): string[] {
    const completed: string[] = [];
    if (this.phase === "passed" || this.phase === "failed") return completed;
    this.bytesIn += chunk.length;
    for (const byte of chunk) {
      if (byte === 0x0a) {
        if (this.lineBytes.length > 0 && this.lineBytes[this.lineBytes.length - 1] === 0x0d) {
          this.lineBytes.pop();
        }
        const text = String.fromCharCode(...this.lineBytes);
        this.lineBytes = [];
        completed.push(text);
        this.linesSeen += 1;
        this.consumeLine(text);
        continue;
      }
      if (this.lineBytes.length >= FWVAL_MAX_LINE) {
        this.lineOverflow = true;
        this.lineBytes = [];
        continue;
      }
      this.lineBytes.push(byte);
    }
    if (this.lineOverflow) {
      this.lineOverflow = false;
      this.fail("line-too-long", `serial line exceeded ${FWVAL_MAX_LINE} bytes`);
    }
    return completed;
  }

  /** Applies the ready/response deadlines. Call periodically with the current time. */
  tick(nowMs: number = this.now()): void {
    if (this.phase === "awaiting-ready" && nowMs - this.startedAtMs >= this.readyTimeoutMs) {
      this.fail("ready-timeout", `no READY line within ${this.readyTimeoutMs} ms`);
    } else if (this.phase === "challenge-issued" && this.challenge !== null) {
      if (nowMs - this.challenge.issuedAtMs >= this.challengeTimeoutMs) {
        this.fail("response-timeout", `no matching RESPONSE within ${this.challengeTimeoutMs} ms`);
      }
    }
  }

  /** The transport closed before the run could pass. */
  disconnect(detail: string): void {
    if (this.phase === "passed") return;
    this.fail("disconnected", detail);
  }

  /** Ends the run if it is still open, then returns the immutable record. */
  finish(): FwValRecord {
    if (this.phase !== "passed" && this.phase !== "failed") {
      this.tick();
    }
    const verdict: FwValRecord["verdict"] =
      this.phase === "passed" ? "pass" : this.phase === "failed" ? "fail" : "incomplete";
    return {
      protocol: FWVAL_PROTOCOL,
      runId: this.runId,
      transport: this.transport,
      evidence: evidenceFor(this.transport),
      phase: this.phase,
      verdict,
      startedAtMs: this.startedAtMs,
      finishedAtMs: this.finishedAtMs,
      challenge: this.challenge,
      device: this.device,
      response: this.response,
      expectedValue: this.expectedValue,
      consoles: [...this.consoles],
      failure: this.failure,
      bytesIn: this.bytesIn,
      linesSeen: this.linesSeen,
      ignoredLines: this.ignoredLines,
    };
  }

  private consumeLine(text: string): void {
    if (this.phase === "passed" || this.phase === "failed") return;
    const trimmed = text.trimEnd();
    if (trimmed.length === 0) {
      this.ignoredLines += 1;
      return;
    }
    if (!trimmed.startsWith(FWVAL_PROTOCOL)) {
      // Boot ROM / IDF log lines share UART0. They are counted, never trusted.
      this.ignoredLines += 1;
      return;
    }
    if (trimmed.length > FWVAL_PROTOCOL_MAX_LINE) {
      this.fail("line-too-long", `protocol line exceeded ${FWVAL_PROTOCOL_MAX_LINE} bytes`);
      return;
    }
    const parsed = parseFields(trimmed);
    if (parsed === null) {
      this.fail("protocol-error", `malformed line: ${trimmed}`);
      return;
    }
    switch (parsed.verb) {
      case "READY":
        this.consumeReady(parsed.fields, trimmed);
        return;
      case "RESPONSE":
        this.consumeResponse(parsed.fields, trimmed);
        return;
      case "ERROR":
        this.fail("device-error", `device reported ${parsed.fields.code ?? "unknown"}`);
        return;
      default:
        this.fail("protocol-error", `unexpected verb: ${parsed.verb}`);
    }
  }

  private consumeReady(fields: Record<string, string>, raw: string): void {
    const identity: ReadyLine = {
      fwid: fields.fw ?? "",
      proto: fields.proto ?? "",
      soc: fields.soc ?? "",
      console: fields.console ?? "",
    };
    if ((this.phase === "ready" || this.phase === "challenge-issued") && this.device !== null) {
      // The host may ask for the identity again (HELLO) and the answer can cross the challenge in
      // flight. A second READY that repeats the SAME firmware identity is the same boot: the image
      // announces itself once per attached channel, so `console` legitimately differs between the
      // UART0 line and the USB-Serial/JTAG line of one boot. Console is a transport label, not
      // identity. A different fwid/proto/soc still fails closed.
      // A real reboot is proven by the boot banner, a reset reason or a counter regression — the
      // stability monitor records those — and it also loses the fresh token, so it cannot produce a
      // matching RESPONSE.
      if (identity.fwid === this.device.fwid && identity.proto === this.device.proto && identity.soc === this.device.soc) {
        this.ignoredLines += 1;
        if (identity.console && !this.consoles.includes(identity.console)) this.consoles.push(identity.console);
        return;
      }
      this.fail("reboot-detected", `READY identity changed after ${this.phase}: ${raw}`);
      return;
    }
    if (this.phase !== "awaiting-ready") {
      this.fail("reboot-detected", `second READY after ${this.phase}: ${raw}`);
      return;
    }
    if (identity.fwid === "" || identity.proto !== "1" || identity.soc !== "esp32c3") {
      this.fail("protocol-error", `incomplete READY line: ${raw}`);
      return;
    }
    if (this.expectedFwid !== undefined && identity.fwid !== this.expectedFwid) {
      this.fail("fwid-mismatch", `expected fw=${this.expectedFwid}, received fw=${identity.fwid}`);
      return;
    }
    this.device = identity;
    if (identity.console && !this.consoles.includes(identity.console)) this.consoles.push(identity.console);
    this.phase = "ready";
  }

  private consumeResponse(fields: Record<string, string>, raw: string): void {
    if (this.phase === "awaiting-ready") {
      this.fail("response-before-ready", raw);
      return;
    }
    if (this.phase !== "challenge-issued" || this.challenge === null || this.device === null) {
      this.fail("protocol-error", `unexpected RESPONSE in phase ${this.phase}`);
      return;
    }
    const response: FwValResponse = {
      token: fields.token ?? "",
      value: fields.value ?? "",
      fwid: fields.fw ?? "",
    };
    this.response = response;
    if (response.token !== this.challenge.token) {
      this.fail("stale-token", `expected token=${this.challenge.token}, received token=${response.token}`);
      return;
    }
    if (response.fwid !== this.device.fwid) {
      this.fail("fwid-mismatch", `expected fw=${this.device.fwid}, received fw=${response.fwid}`);
      return;
    }
    const expected = fwvalAnswer(this.challenge.token, this.device.fwid);
    if (response.value !== expected) {
      this.fail("value-mismatch", `expected value=${expected}, received value=${response.value}`);
      return;
    }
    this.expectedValue = expected;
    this.phase = "passed";
    this.finishedAtMs = this.now();
  }

  private fail(code: FwValFailureCode, detail: string): void {
    if (this.phase === "passed" || this.phase === "failed") return;
    this.failure = { code, detail };
    this.phase = "failed";
    this.finishedAtMs = this.now();
  }
}

// ---------------------------------------------------------------------------------------------
// Development-task stability sampling.
//
// The automatic firmware task keeps ONE hardware session open after the challenge and asks the
// device for COUNT twenty times, then observes the same transport for a bounded window. Nothing
// here trusts a timestamp, a log file or a closed session: the caller feeds the bytes it reads
// from that live session and this pure monitor decides whether the counter really advanced and
// whether the boot was interrupted.

/** Exact COUNT reply: `AETHER-VAL/1 COUNT value=<decimal>`. */
export const FWVAL_COUNT_PATTERN = /^AETHER-VAL\/1 COUNT value=(\d{1,10})$/;
/** Markers that only appear when the SoC booted again or the firmware faulted. */
const RESTART_MARKERS: { code: string; pattern: RegExp }[] = [
  { code: "task_wdt", pattern: /\btask_wdt\b/ },
  { code: "interrupt_wdt", pattern: /\binterrupt_wdt\b/ },
  { code: "guru-meditation", pattern: /Guru Meditation Error/ },
  { code: "panic", pattern: /panic'ed|Panic was triggered/ },
  { code: "core-reset", pattern: /Core\s+\d+ was reset/ },
  { code: "cpu-halted", pattern: /CPU halted/ },
  { code: "stack-watchpoint", pattern: /Stack canary watchpoint|Backtrace:/ },
  { code: "reset-reason", pattern: /\brst:0x/ },
  { code: "bootrom-banner", pattern: /ESP-ROM:esp32c3/ },
];

export interface FwValStabilityResult {
  /** Every COUNT value observed, in arrival order. */
  counts: number[];
  requests: number;
  strictlyIncreasing: boolean;
  restartDetected: boolean;
  /** Code names from RESTART_MARKERS, de-duplicated, in first-seen order. */
  restartMarkers: string[];
  /** READY identity strings seen during the window (an identical repeat is not a reboot). */
  readyIdentities: string[];
  failure: string;
}

/**
 * Consumes raw bytes from the live session that already passed the challenge. It counts only
 * complete COUNT lines, rejects regressions (a counter that went backwards means a new boot,
 * even when the host missed the boot banner) and records restart/watchdog markers verbatim.
 */
export class FwValStabilityMonitor {
  private readonly expected: number;
  private readonly observeStartMs: number;
  private readonly now: () => number;
  private lineBytes: number[] = [];
  private overflow = false;
  private readonly counts: number[] = [];
  private requests = 0;
  private failureText = "";
  private readonly restartMarkers: string[] = [];
  private readonly readyIdentities: string[] = [];
  private pendingSince = 0;

  constructor(options: { runId: string; expectedCounts: number; now?: () => number }) {
    this.expected = options.expectedCounts;
    this.now = options.now ?? (() => Date.now());
    this.observeStartMs = this.now();
    void options.runId;
  }

  get observed(): number { return this.counts.length; }
  get startedAtMs(): number { return this.observeStartMs; }
  get failure(): string { return this.failureText; }

  /** Records that the host just asked for a COUNT; a missing reply is a failure, not a pause. */
  request(): void {
    if (this.requests < this.expected) this.requests += 1;
    this.pendingSince = this.now();
  }

  /** Called periodically: a COUNT reply that never arrives fails the sampling. */
  tick(timeoutMs = FWVAL_CHALLENGE_TIMEOUT_MS): void {
    if (!this.pendingSince || this.failureText) return;
    if (this.now() - this.pendingSince >= timeoutMs) {
      this.fail("count-timeout");
      this.pendingSince = 0;
    }
  }

  feed(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        if (this.lineBytes.length > 0 && this.lineBytes[this.lineBytes.length - 1] === 0x0d) this.lineBytes.pop();
        const text = String.fromCharCode(...this.lineBytes);
        this.lineBytes = [];
        this.consume(text);
        continue;
      }
      if (this.lineBytes.length >= FWVAL_MAX_LINE) {
        this.overflow = true;
        this.lineBytes = [];
        continue;
      }
      this.lineBytes.push(byte);
    }
    if (this.overflow) {
      this.overflow = false;
      this.fail("line-too-long");
    }
  }

  finish(): FwValStabilityResult {
    const previous: number[] = [];
    let strictlyIncreasing = true;
    for (const value of this.counts) {
      const last = previous[previous.length - 1];
      if (last !== undefined && value <= last) strictlyIncreasing = false;
      previous.push(value);
    }
    const failure = this.failureText || (this.counts.length < this.expected ? "count-incomplete" : "");
    return {
      counts: [...this.counts],
      requests: this.requests,
      strictlyIncreasing: strictlyIncreasing && this.counts.length > 0,
      restartDetected: this.restartMarkers.length > 0,
      restartMarkers: [...this.restartMarkers],
      readyIdentities: [...this.readyIdentities],
      failure,
    };
  }

  private consume(raw: string): void {
    const text = raw.trimEnd();
    if (!text) return;
    for (const marker of RESTART_MARKERS) {
      if (marker.pattern.test(text) && !this.restartMarkers.includes(marker.code)) this.restartMarkers.push(marker.code);
    }
    const ready = /^AETHER-VAL\/1 READY\b.*$/.exec(text);
    if (ready) {
      if (!this.readyIdentities.includes(ready[0])) this.readyIdentities.push(ready[0]);
      return;
    }
    const count = FWVAL_COUNT_PATTERN.exec(text);
    if (!count) return;
    this.pendingSince = 0;
    this.counts.push(Number(count[1]));
  }

  private fail(code: string) {
    if (!this.failureText) this.failureText = code;
  }
}
