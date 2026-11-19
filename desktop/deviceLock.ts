// One COM port cannot be used by the monitor, an upload/build task, a flash operation and the ESP
// read-only entries at the same time. There is exactly one arbiter for the whole host process.
//
// Ownership is claimed synchronously, before any await, so a slow start path cannot slip past the
// check. Every claim returns its own token: a release only clears the token that still holds the
// lease, so a late close, a stale reply or a cancelled task can never free a newer owner.
export type DeviceOwner = "monitor" | "task" | "flash" | (string & {});

const labels: Record<string, string> = { monitor: "串口监视器", task: "构建/上传任务", flash: "Flash 备份/恢复" };

export interface DeviceLeaseToken {
  readonly id: number;
  readonly owner: DeviceOwner;
  /** Normalized port name; null until the owner knows (and binds) the port it will use. */
  port: string | null;
}

export const normalizePort = (port: string) => port.trim().toUpperCase();
export const leaseLabel = (owner: DeviceOwner) => labels[owner] ?? owner;

function busyError(holder: DeviceLeaseToken) {
  const label = leaseLabel(holder.owner);
  return new Error(holder.port
    ? "端口 " + holder.port + " 正被" + label + "占用；请先结束它再执行此操作。"
    : label + "正在占用串口；请先结束它再执行此操作。");
}

export class DeviceLease {
  private ownerToken: DeviceLeaseToken | null = null;
  private seq = 0;

  /** Claims the single port slot synchronously. Throws while anyone holds it. */
  claim(owner: DeviceOwner, port?: string): DeviceLeaseToken {
    if (this.ownerToken) throw busyError(this.ownerToken);
    const token: DeviceLeaseToken = { id: ++this.seq, owner, port: port?.trim() ? normalizePort(port) : null };
    this.ownerToken = token;
    return token;
  }

  /**
   * Binds the port a token will use. Called once the port is known (an upload task learns its port
   * after the reservation); a token cannot silently switch to a second port.
   */
  bind(token: DeviceLeaseToken, port: string): DeviceLeaseToken {
    if (this.ownerToken?.id !== token.id) throw new Error("串口租约已失效，请重新开始操作");
    const name = normalizePort(port);
    if (!name) throw new Error("请先选择端口");
    if (token.port && token.port !== name) throw new Error("同一操作不能持有两个端口：" + token.port + " / " + name);
    token.port = name;
    return token;
  }

  /** Releases only if this exact token still holds the lease; a stale token is ignored. */
  release(token: DeviceLeaseToken | null | undefined): boolean {
    if (!token || this.ownerToken?.id !== token.id) return false;
    this.ownerToken = null;
    return true;
  }

  /** True only while this exact token still holds the lease. */
  holds(token: DeviceLeaseToken | null | undefined): boolean {
    return !!token && this.ownerToken?.id === token.id;
  }

  current(): DeviceLeaseToken | null { return this.ownerToken; }
  holder(): DeviceOwner | null { return this.ownerToken?.owner ?? null; }
}

/** The single arbiter shared by every host entry that opens the COM port. */
export const deviceLease = new DeviceLease();
