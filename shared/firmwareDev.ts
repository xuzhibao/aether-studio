// Contract between the host FirmwareDevService and the renderer Agent panel.
//
// The host owns the trusted session: the project directory it was opened on, the PlatformIO
// environment, the dedicated ESP32-C3 board port and whether this run may write the active app slot.
// The renderer may display this view and hand typed tool calls back, but it can neither create a
// session nor widen one. Every value below comes from real host work.

/** Only these existing firmware sources may be edited during an authorized automatic task. */
export const FIRMWARE_SOURCE_SCOPE = /^(?:src|main)\/(?!\.)[A-Za-z0-9._-]+(?:\/(?!\.)[A-Za-z0-9._-]+)*\.(?:c|h|cpp|hpp)$/;
/** Rejects absolute paths, traversal and every generated or build-owned file. */
export const isEditableFirmwareSource = (name: string) =>
  typeof name === "string" && name.length <= 240 && FIRMWARE_SOURCE_SCOPE.test(name) && !name.split("/").includes("..") && !name.split("/").some((part) => part === "" || part === ".");

export type FirmwareDevStage = "ready" | "built" | "simulated" | "previewed" | "written" | "verified";

export interface FirmwareDevStepView {
  name: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  detail: string;
  startedAt: string;
  endedAt?: string;
}

export interface FirmwareDevSessionView {
  /** True while the host still holds the session (until stop or project switch). */
  active: boolean;
  stage: FirmwareDevStage;
  root: string;
  environment: string;
  port: string;
  device: { chipName: string; revision: string; flashSize: number | null } | null;
  appOnlyWriteAuthorized: boolean;
  sourceEditAuthorized: boolean;
  build: { taskId: string; appSha256: string; inputHash: string; firmwareBytes: number } | null;
  qemu: { evidenceId: string; appSha256: string; boots: number; fwid: string; recordedAt: string } | null;
  preview: { appSha256: string; slot: { label: string; offset: number; size: number }; erase: { offset: number; size: number }; expiresAt: string } | null;
  write: { taskId: string; status: string; appSha256: string; planSha256: string; started: boolean } | null;
  challenge: { evidenceId: string; passed: boolean; bound: boolean; sessionId: number } | null;
  stability: { counts: number[]; observeMs: number; observedMs: number; strictlyIncreasing: boolean; restartDetected: boolean; watchdogLines: string[]; failures: string[] } | null;
  cancelled: boolean;
  error: string;
  startedAt: string;
  steps: FirmwareDevStepView[];
}

export interface FirmwareDevStartOptions {
  environment: string;
  port: string;
  /** Explicit user confirmation that this run may write the active OTA app slot only. */
  appOnlyWrite: boolean;
  /** Explicit user confirmation that this run may edit the existing firmware sources in scope. */
  sourceEdit: boolean;
}

export interface FirmwareDevAPI {
  start: (options: FirmwareDevStartOptions) => Promise<FirmwareDevSessionView>;
  status: () => Promise<FirmwareDevSessionView>;
  stop: () => Promise<FirmwareDevSessionView>;
  build: () => Promise<FirmwareDevSessionView>;
  simulate: () => Promise<FirmwareDevSessionView>;
  preview: () => Promise<FirmwareDevSessionView>;
  write: () => Promise<FirmwareDevSessionView>;
  challenge: () => Promise<FirmwareDevSessionView>;
  /** Host-checked, host-written edit of one existing in-scope firmware source (automatic task only). */
  applyEdit: (options: { path: string; expected: string; content: string }) => Promise<{ path: string; before: string; after: string }>;
  onChanged: (listener: (view: FirmwareDevSessionView) => void) => () => void;
}
