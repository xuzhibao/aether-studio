// One COM port cannot be used by the monitor, an upload/build task and a flash operation at the same time.
// Ownership is claimed synchronously, before any await, so a slow start path cannot slip past the check.
export type DeviceOwner = "monitor" | "task" | "flash";

const labels: Record<DeviceOwner, string> = { monitor: "串口监视器", task: "构建/上传任务", flash: "Flash 备份/恢复" };

export class DeviceLease {
  private owner: DeviceOwner | null = null;
  claim(owner: DeviceOwner) {
    if (this.owner && this.owner !== owner) throw new Error(labels[this.owner] + "正在占用串口；请先结束它再执行此操作。");
    this.owner = owner;
  }
  release(owner: DeviceOwner) { if (this.owner === owner) this.owner = null; }
  holder() { return this.owner; }
}
