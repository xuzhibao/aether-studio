// One in-process lease per serial port so the monitor, an upload, a read-only inspection and a
// backup can never hold the same port at the same time. The renderer cannot see this table; it
// only receives readable errors.
const leases = new Map<string, string>();

const key = (port: string) => port.trim().toUpperCase();

export function acquirePort(port: string, owner: string) {
  const name = key(port);
  if (!name) throw new Error("请先选择端口");
  const held = leases.get(name);
  if (held) throw new Error("端口 " + port.toUpperCase() + " 正被 " + held + " 占用，请先结束该操作");
  leases.set(name, owner);
}

export function releasePort(port: string) {
  leases.delete(key(port));
}

export function portOwner(port: string): string | null {
  return leases.get(key(port)) ?? null;
}

export function isPortBusy(port: string): boolean {
  return leases.has(key(port));
}

/** Runs `fn` while holding the port; the lease is released even when `fn` throws. */
export async function withPort<T>(port: string, owner: string, fn: () => Promise<T>): Promise<T> {
  acquirePort(port, owner);
  try { return await fn(); } finally { releasePort(port); }
}
