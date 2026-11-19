import type { FwValRecord, FwValTransport } from "./firmwareValidation";

// Shared contract between the host FirmwareVerificationService and the renderer panel.
// The host is the only producer of `passed`; the renderer only displays these records.

export interface SimulatorLiveView {
  status: "running" | "stopped" | "failed";
  uart: string;
  uartChars: number;
  diagnostics: string;
  qemu: { executable: string; version: string };
  app: { path: string; sha256: string; size: number };
  flash: { sha256: string; size: number };
  argv: string[];
  error?: string;
}

export interface VirtualBootView {
  record: FwValRecord;
  appSha256: string;
  status: "running" | "stopped" | "failed";
  stopReason?: "timeout" | "cancel" | "exit";
  pid: number | null;
  uartChars: number;
  bootBanner: boolean;
  qemu: { executable: string; version: string };
  build: { recordSha256: string; inputHash: string; builtAt: string };
  flash: { sha256: string; size: number; appBytes: number };
  argv: string[];
  uartTail: string;
}

export interface QemuEvidenceView {
  version: 1;
  id: string;
  passed: boolean;
  root: string;
  environment: string;
  appSha256: string;
  inputHash: string;
  recordedAt: string;
  startedAt: string;
  boots: VirtualBootView[];
  identity: { fwid: string; stable: boolean };
  error?: string;
}

export interface ArmedDeployView {
  evidenceId: string;
  root: string;
  environment: string;
  appSha256: string;
  inputHash: string;
  port: string;
  armedAt: string;
}

export interface HardwareEvidenceView {
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

export interface VerificationStatusView {
  running: boolean;
  live: SimulatorLiveView | null;
  evidence: QemuEvidenceView | null;
  armed: ArmedDeployView | null;
  hardware: HardwareEvidenceView | null;
  error: string;
}

export interface FirmwareVerificationAPI {
  status: () => Promise<VerificationStatusView>;
  startSimulation: (options: { environment: string; boots?: number; timeoutMs?: number }) => Promise<QemuEvidenceView>;
  cancel: () => Promise<void>;
  armDeploy: (options: { port: string }) => Promise<ArmedDeployView>;
  disarm: () => Promise<void>;
  runDevice: (options: { port: string; transport?: FwValTransport; timeoutMs?: number }) => Promise<HardwareEvidenceView>;
  onChanged: (listener: (status: VerificationStatusView) => void) => () => void;
}
