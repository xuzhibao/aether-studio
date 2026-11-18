// Shared contract for the ESP flash backup / restore feature.
// The desktop host owns esptool; the renderer only ever sees these plain data shapes.
// Nothing in this file may carry secrets: no eFuse dumps, no keys, no raw credential material.

/** Read-only identity of one attached chip, collected with esptool `flash_id` / `read_mac`. */
export interface FlashDeviceInfo {
  port: string;
  chip: string;
  /** Human-readable detail line reported by esptool, e.g. "(QFN32) (revision v0.4)". */
  detail: string;
  revision: string;
  flashSizeBytes: number;
  flashSizeLabel: string;
  flashManufacturerId: string;
  flashDeviceId: string;
  mac: string;
  features: string[];
  crystal: string;
  esptoolVersion: string;
  detectedAt: string;
}

/** Read-only security posture. Unknown values block restore instead of being guessed. */
export interface FlashSecurityInfo {
  checked: boolean;
  secureBootEnabled: boolean | null;
  flashEncryptionEnabled: boolean | null;
  note: string;
}

/** What the installed esptool actually supports, verified from its own help output. */
export interface FlashCapabilities {
  version: string;
  readFlash: boolean;
  writeFlash: boolean;
  getSecurityInfo: boolean;
  /** write_flash must accept `--flash_mode keep` so the image header survives a restore. */
  preservesImageHeaders: boolean;
  /** Explicit `--verify` support; writing is still checked by reading the bytes back. */
  verifyOption: boolean;
  help: string;
}

export interface FlashChunkOptions {
  /** Bytes per esptool read_flash / write_flash call. 512 KiB by default. */
  chunkSize: number;
  baudRate: number;
  /** Extra attempts per chunk after the first failure. */
  retries: number;
}

export interface FlashBackupOptions extends FlashChunkOptions {
  port: string;
  /** User-chosen output path. Must end with .bin and live outside the opened project. */
  outputPath: string;
}

export interface FlashRestorePrepareOptions extends FlashChunkOptions {
  port: string;
  backupPath: string;
}

export type FlashPhase =
  | "detecting" | "reading" | "comparing" | "writing" | "reading-back"
  | "finalizing" | "done" | "cancelled" | "failed";

export interface FlashProgress {
  phase: FlashPhase;
  offset: number;
  total: number;
  chunkIndex: number;
  chunkCount: number;
  message: string;
  /** Set when a chunk finally failed, so the UI can name the exact offset. */
  failedOffset?: number;
}

/** Non-sensitive manifest stored next to a backup. */
export interface FlashBackupMetadata {
  format: "aether-flash-backup";
  version: 1;
  createdAt: string;
  device: {
    chip: string;
    revision: string;
    flashSizeBytes: number;
    flashSizeLabel: string;
    flashManufacturerId: string;
    flashDeviceId: string;
    /** Device identifier used to refuse a restore onto a different board; not a secret. */
    mac: string;
    features: string[];
  };
  fileLength: number;
  /** SHA-256 of the whole image. */
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  esptoolVersion: string;
  /** Sanity markers found while assembling; never copied out of the image itself. */
  sanity: { bootloaderMagic: boolean; partitionMagic: boolean };
}

export interface FlashBackupResult {
  outputPath: string;
  metadataPath: string;
  metadata: FlashBackupMetadata;
  chunkAttempts: number;
  retriesUsed: number;
  cacheDir: string;
}

export interface FlashRange { offset: number; size: number }

export interface FlashRestorePlan {
  planId: string;
  createdAt: string;
  expiresAt: string;
  port: string;
  backupPath: string;
  metadata: FlashBackupMetadata;
  device: FlashDeviceInfo;
  security: FlashSecurityInfo;
  verification: {
    fileLength: boolean;
    sha256: boolean;
    deviceMatch: boolean;
    securityClear: boolean;
    /** Length equals the recorded flash capacity and is a positive 4 KiB multiple. */
    wholeImage: boolean;
  };
  /** Differing ranges that would be written. Empty means the chip already matches the backup. */
  ranges: FlashRange[];
  totalBytes: number;
  /** Exact text the user must type before any write starts. */
  confirmationPhrase: string;
  warnings: string[];
  /** Non-empty means restore is refused; the reason is shown verbatim. */
  blocked: string;
}

export interface FlashRestoreResult {
  planId: string;
  status: "completed" | "partial" | "cancelled" | "failed";
  writtenRanges: (FlashRange & { verified: boolean })[];
  remainingRanges: FlashRange[];
  readBackVerified: boolean;
  message: string;
  cacheDir: string;
}

export type FlashStatus = "idle" | "detecting" | "backing-up" | "restoring" | "cancelling";

export interface FlashSnapshot {
  status: FlashStatus;
  operation: "backup" | "restore" | null;
  progress: FlashProgress | null;
  backup: FlashBackupResult | null;
  restore: FlashRestoreResult | null;
  plan: FlashRestorePlan | null;
  error: string;
  log: string[];
  cacheDir: string;
}

export interface FlashPort { path: string; label: string; detail?: string }

export interface FlashAPI {
  snapshot: () => Promise<FlashSnapshot>;
  toolStatus: () => Promise<import("./tools").ToolStatus>;
  capabilities: () => Promise<FlashCapabilities>;
  describe: (port: string) => Promise<FlashDeviceInfo>;
  chooseBackupPath: (suggestedName: string) => Promise<string | null>;
  chooseBackupFile: () => Promise<string | null>;
  readMetadata: (backupPath: string) => Promise<FlashBackupMetadata>;
  startBackup: (options: FlashBackupOptions) => Promise<FlashBackupResult>;
  prepareRestore: (options: FlashRestorePrepareOptions) => Promise<FlashRestorePlan>;
  executeRestore: (planId: string, confirmation: string) => Promise<FlashRestoreResult>;
  cancel: () => Promise<void>;
  onChanged: (listener: (snapshot: FlashSnapshot) => void) => () => void;
}
