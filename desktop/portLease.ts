import { deviceLease } from "./deviceLock";

// Per-port bookkeeping on top of the single DeviceLease: gives readable port-level errors and lets the
// upload provider hold the device from the final detection through the write.
const owners = new Map<string, string>();
const key = (port: string) => port.trim().toUpperCase();

export function acquirePort(port: string, owner: string) {
  const name = key(port);
  if (!name) throw new Error("请先选择端口");
  const held = owners.get(name);
  if (held) throw new Error("端口 " + port.toUpperCase() + " 正被 " + held + " 占用，请先结束该操作");
  // The global lease also covers consumers that do not name a port (flash backup, monitor).
  deviceLease.claim(owner);
  owners.set(name, owner);
}

export function releasePort(port: string) {
  const name = key(port);
  const owner = owners.get(name);
  if (owner === undefined) return;
  owners.delete(name);
  deviceLease.release(owner);
}

export function portOwner(port: string): string | null {
  return owners.get(key(port)) ?? null;
}

export function isPortBusy(port: string): boolean {
  return owners.has(key(port));
}

/** Runs `fn` while holding the port; the lease is released even when `fn` throws. */
export async function withPort<T>(port: string, owner: string, fn: () => Promise<T>): Promise<T> {
  acquirePort(port, owner);
  try { return await fn(); } finally { releasePort(port); }
}
