import { deviceLease, normalizePort, type DeviceLeaseToken } from "./deviceLock";

// Per-port convenience on top of the single device lease: callers that already know the port get a
// readable port-level error and a lease that is held for the whole operation.
export function acquirePort(port: string, owner: string): DeviceLeaseToken {
  if (typeof port !== "string" || !port.trim()) throw new Error("请先选择端口");
  return deviceLease.claim(owner, port);
}

/** Releases the caller's own token; a stale token from a finished operation frees nothing. */
export function releasePort(token: DeviceLeaseToken | null | undefined) { deviceLease.release(token); }

export function portOwner(port: string): string | null {
  const holder = deviceLease.current();
  return holder && holder.port === normalizePort(port) ? holder.owner : null;
}

export function isPortBusy(port: string): boolean {
  return portOwner(port) !== null;
}

/** Runs `fn` while holding the port; the lease is released even when `fn` throws. */
export async function withPort<T>(port: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const token = acquirePort(port, owner);
  try { return await fn(); } finally { releasePort(token); }
}
