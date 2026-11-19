import { SerialPort } from "serialport";
interface SerialSession { id: number; port: SerialPort; bytes: number[]; error?: Error; opened: boolean }
export type SerialPortFactory = (path: string, baudRate: number) => SerialPort;
export class SerialService {
  private next = 0;
  private session?: SerialSession;
  // Keeps the real end reason for one read after the session is gone (overflow/unplug), instead of a generic error.
  private endedError?: { id: number; error: Error };
  private onSessionEnd?: (opened: boolean) => void;
  constructor(private createPort: SerialPortFactory = (path, baudRate) => new SerialPort({ path, baudRate, autoOpen: false })) {}
  /** Called when a session ends for any reason; `opened` is false for an attempt that never opened the port. */
  setOnSessionEnd(callback: (opened: boolean) => void) { this.onSessionEnd = callback; }
  /** True while the monitor owns a port; flash operations must not open the same device. */
  isOpen() { return !!this.session; }
  private endSession(session: SerialSession) {
    if (this.session?.id !== session.id) return;
    this.session = undefined;
    if (session.error) this.endedError = { id: session.id, error: session.error };
    this.onSessionEnd?.(session.opened);
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
    this.endedError = undefined;
    const port = this.createPort(path, baudRate);
    const session: SerialSession = { id: ++this.next, port, bytes: [], error: undefined, opened: false };
    this.session = session;
    port.on("data", (data: Buffer) => { if (session.bytes.length + data.length > 1024 * 1024) { session.error = new Error("串口接收缓存已满，连接已停止，请降低输出频率后重连"); if (port.isOpen) port.close(); return; } session.bytes.push(...data); });
    port.on("error", (error: Error) => { session.error = error; this.endSession(session); if (port.isOpen) port.close(); });
    port.on("close", () => { session.error ??= new Error("串口已关闭"); this.endSession(session); });
    try { await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve())); session.opened = true; return session.id; }
    catch (error) { this.endSession(session); throw error; }
  }
  private require(id: number) {
    if (this.session?.id !== id) {
      // A poll that arrives after an overflow/unplug must see the real reason, not "already closed".
      if (this.endedError?.id === id) throw this.endedError.error;
      throw new Error("串口连接已关闭");
    }
    if (this.session.error) throw this.session.error;
    return this.session;
  }
  async read(id: number) { return this.require(id).bytes.splice(0, 4096); }
  async write(id: number, bytes: number[]) {
    const { port } = this.require(id);
    await new Promise<void>((resolve, reject) => port.write(Buffer.from(bytes), (error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => port.drain((error) => error ? reject(error) : resolve()));
  }
  /** True only when this id owned the current session and the native close completed. */
  async close(id: number) {
    if (this.session?.id !== id) return false;
    const session = this.session;
    if (session.port.opening) await new Promise<void>((resolve) => { session.port.once("open", () => resolve()); session.port.once("error", () => resolve()); });
    if (session.port.isOpen) await new Promise<void>((resolve, reject) => session.port.close((error) => error ? reject(error) : resolve()));
    // A close/error event may have ended the session while we awaited; only this call's own end releases the lease.
    const owned = this.session?.id === session.id;
    this.endSession(session);
    return owned;
  }
  async dispose() { if (this.session) await this.close(this.session.id); }
}
