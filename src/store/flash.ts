import { create } from "zustand";
import { isDesktop } from "../lib/desktop";
import type {
  FlashBackupOptions, FlashBackupResult, FlashCapabilities, FlashDeviceInfo, FlashRestorePlan,
  FlashRestorePrepareOptions, FlashRestoreResult, FlashSnapshot,
} from "../../shared/flash";

// One flash operation at a time. The snapshot mirrors the desktop service so the monitor,
// the upload task and the flash panel all agree about who owns the COM port.
interface FlashState {
  snapshot: FlashSnapshot | null;
  error: string;
  starting: boolean;
  init: () => Promise<void>;
  capabilities: () => Promise<FlashCapabilities>;
  describe: (port: string) => Promise<FlashDeviceInfo>;
  chooseBackupPath: (suggestedName: string) => Promise<string | null>;
  chooseBackupFile: () => Promise<string | null>;
  readMetadata: (backupPath: string) => Promise<import("../../shared/flash").FlashBackupMetadata>;
  startBackup: (options: FlashBackupOptions) => Promise<FlashBackupResult>;
  prepareRestore: (options: FlashRestorePrepareOptions) => Promise<FlashRestorePlan>;
  executeRestore: (planId: string, confirmation: string) => Promise<FlashRestoreResult>;
  cancel: () => Promise<void>;
  clearPlan: () => void;
  setError: (error: string) => void;
}

const desktop = () => {
  if (!isDesktop() || !window.aether?.flash) throw new Error("Flash 备份/恢复仅支持 Electron 桌面端");
  return window.aether.flash;
};

/** True while a flash operation owns the device; other port users must wait. */
export function flashBusy() {
  const snapshot = useFlash.getState().snapshot;
  return !!snapshot && snapshot.status !== "idle";
}

let subscribed = false;

/** The monitor and upload tasks release the port before flash starts; otherwise nothing is written. */
async function releasePort() {
  const { useTransport } = await import("./transport");
  const { useDisk } = await import("./disk");
  if (useDisk.getState().tasks.some((task) => task.status === "running") || useDisk.getState().starting) {
    throw new Error("构建/上传任务正在运行，请完成或取消后再执行 Flash 操作");
  }
  await useTransport.getState().disconnect();
  if (useTransport.getState().status !== "disconnected") throw new Error("串口监视器尚未释放端口，已取消 Flash 操作。请手动断开连接后重试。");
}

export const useFlash = create<FlashState>((set, get) => {
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    set({ starting: true, error: "" });
    try { return await action(); }
    catch (error) { set({ error: String((error as Error)?.message ?? error) }); throw error; }
    finally { set({ starting: false }); }
  };
  return {
    snapshot: null,
    error: "",
    starting: false,
    init: async () => {
      if (!isDesktop() || !window.aether?.flash) return;
      if (!subscribed) {
        subscribed = true;
        window.aether.flash.onChanged((snapshot) => set({ snapshot }));
      }
      set({ snapshot: await window.aether.flash.snapshot() });
    },
    capabilities: () => run(() => desktop().capabilities()),
    describe: (port) => run(() => desktop().describe(port)),
    chooseBackupPath: (suggestedName) => desktop().chooseBackupPath(suggestedName),
    chooseBackupFile: () => desktop().chooseBackupFile(),
    readMetadata: (backupPath) => desktop().readMetadata(backupPath),
    startBackup: (options) => run(async () => { await releasePort(); return desktop().startBackup(options); }),
    prepareRestore: (options) => run(async () => { await releasePort(); return desktop().prepareRestore(options); }),
    executeRestore: (planId, confirmation) => run(async () => { await releasePort(); return desktop().executeRestore(planId, confirmation); }),
    cancel: async () => { if (isDesktop() && window.aether?.flash) await window.aether.flash.cancel(); },
    clearPlan: () => set((state) => ({ snapshot: state.snapshot ? { ...state.snapshot, plan: null } : state.snapshot, error: "" })),
    setError: (error) => set({ error }),
  };
});
