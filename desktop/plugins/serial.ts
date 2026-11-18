import { SerialPort } from "serialport";
export class SerialService {
  private next = 0;
  private session?: { id: number; port: SerialPort; bytes: number[]; error?: Error };
  private onSessionEnd?: () => void;
  /** Called when a session ends for any reason (explicit close, unplug, port error). */
  setOnSessionEnd(callback: () => void) { this.onSessionEnd = callback; }
  /** True while the monitor owns a port; flash operations must not open the same device. */
  isOpen() { return !!this.session; }
  private endSession(session: { id: number }) {
    if (this.session?.id !== session.id) return;
    this.session = undefined;
    this.onSessionEnd?.();
  }
  async list() {
    return (await SerialPort.list()).map((port) => ({
      path: port.path,
      label: port.manufacturer || "Serial port",
      // OS-reported descriptors only; these do not identify a board model or firmware.
      detail: [port.vendorId && port.productId ? `VID:PID ${port.vendorId}:${port.productId}` : "", port.serialNumber ? `SN ${port.serialNumber}` : ""].filter(Boolean).join(" · ") || undefined,
    }));
  }
  async open(path: string, baudRate: number) {
    if (this.session) throw new Error("已有打开的串口");
    if (!path || !Number.isInteger(baudRate) || baudRate <= 0) throw new Error("无效的串口参数");
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    const session = { id: ++this.next, port, bytes: [] as number[], error: undefined as Error | undefined };
    this.session = session;
    port.on("data", (data: Buffer) => { if (session.bytes.length + data.length > 1024 * 1024) { session.error = new Error("串口接收缓存已满，连接已停止，请降低输出频率后重连"); if (port.isOpen) port.close(); return; } session.bytes.push(...data); });
    port.on("error", (error: Error) => { session.error = error; this.endSession(session); if (port.isOpen) port.close(); });
    port.on("close", () => { session.error ??= new Error("串口已关闭"); this.endSession(session); });
    try { await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve())); return session.id; }
    catch (error) { this.endSession(session); throw error; }
  }
  private require(id: number) { if (this.session?.id !== id) throw new Error("串口连接已关闭"); if (this.session.error) throw this.session.error; return this.session; }
  async read(id: number) { return this.require(id).bytes.splice(0, 4096); }
  async write(id: number, bytes: number[]) {
    const { port } = this.require(id);
    await new Promise<void>((resolve, reject) => port.write(Buffer.from(bytes), (error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => port.drain((error) => error ? reject(error) : resolve()));
  }
  async close(id: number) {
    if (this.session?.id !== id) return;
    const session = this.session;
    if (session.port.opening) await new Promise<void>((resolve) => { session.port.once("open", () => resolve()); session.port.once("error", () => resolve()); });
    if (session.port.isOpen) await new Promise<void>((resolve, reject) => session.port.close((error) => error ? reject(error) : resolve()));
    this.endSession(session);
  }
  async dispose() { if (this.session) await this.close(this.session.id); }
}
