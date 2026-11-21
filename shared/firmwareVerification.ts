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

/**
 * Host-issued preview of one app-only write. The renderer may display it and hand its token back
 * once; it cannot construct one or widen the write. Every field is bound to a passed QEMU record.
 */
export interface VerifiedDeployView {
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
  preview: VerifiedDeployView | null;
  hardware: HardwareEvidenceView | null;
  error: string;
}

export interface FirmwareVerificationAPI {
  status: () => Promise<VerificationStatusView>;
  startSimulation: (options: { environment: string; boots?: number; timeoutMs?: number }) => Promise<QemuEvidenceView>;
  cancel: () => Promise<void>;
  /** Read-only: re-proves the build, device and active OTA slot, then issues a one-time write preview. */
  previewDeploy: (options: { environment: string; port: string }) => Promise<VerifiedDeployView>;
  /** Starts the app-only write for exactly that preview; never builds and never saves. */
  commitDeploy: (options: { token: string; environment: string; port: string }) => Promise<{ taskId: string }>;
  /** Drops an unused preview (selection change or explicit cancel). */
  disarm: () => Promise<void>;
  runDevice: (options: { port: string; transport?: FwValTransport; timeoutMs?: number }) => Promise<HardwareEvidenceView>;
  onChanged: (listener: (status: VerificationStatusView) => void) => () => void;
}
