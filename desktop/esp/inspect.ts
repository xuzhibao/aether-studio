import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerialPort } from "serialport";
import {
  chipByKey, classifyUsb, describeEsptoolFailure, parseEfuseSummary, parseFlashId, parsePartitionTable,
  type EspInspectResult, type EspPartitionTable, type EspSecurityFacts, type EspToolChipFacts, type EspToolFlashFacts, type EspUsbDescriptor,
} from "../../shared/esp";
import { esptoolVersion, findEsptool, runEsptool, siblingScript, type EsptoolTool } from "./esptool";
import { withPort } from "../portLease";
import type { ToolService } from "../tools";

const PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_TABLE_SIZE = 0x1000;

/** USB descriptors come from the OS; they never identify a board or a firmware. */
export async function usbDescriptorFor(port: string): Promise<EspUsbDescriptor | null> {
  const ports = await SerialPort.list().catch(() => []);
  const match = ports.find((item) => item.path.toUpperCase() === port.toUpperCase());
  if (!match || (!match.vendorId && !match.productId)) return null;
  return {
    vendorId: match.vendorId ?? "", productId: match.productId ?? "",
    manufacturer: match.manufacturer ?? "", product: (match as { friendlyName?: string }).friendlyName ?? "",
  };
}

export interface EspDeviceFacts {
  ok: boolean; error: string;
  chip: EspToolChipFacts | null; flash: EspToolFlashFacts | null;
  chipId: number | null; chipName: string; revision: string; flashSize: number | null;
  partitions: EspPartitionTable;
  security: EspSecurityFacts | null;
  notes: string[];
}

/**
 * Read-only facts from one port: `flash_id`, the on-board partition table at 0x8000 and, when the
 * tool package ships espefuse.py, the three eFuse flags that change flashing safety. No writes.
 * The caller owns the port lease.
 */
export async function readDeviceFacts(tool: EsptoolTool, port: string, signal?: AbortSignal): Promise<EspDeviceFacts> {
  const fail = (error: string): EspDeviceFacts => ({ ok: false, error, chip: null, flash: null, chipId: null, chipName: "", revision: "", flashSize: null, partitions: { entries: [], valid: false, error: "未读取" }, security: null, notes: [] });
  const id = await runEsptool(tool, ["--port", port, "flash_id"], { signal, timeoutMs: 90000 });
  if (id.cancelled) return fail("已取消");
  if (id.code !== 0) return fail(describeEsptoolFailure(id.output));
  const parsed = parseFlashId(id.output);
  if (!parsed.chip) return fail(parsed.errors.join("；") || "无法解析 esptool 输出");
  const chip = chipByKey(parsed.chip.key);

  let partitions: EspPartitionTable = { entries: [], valid: false, error: "未读取" };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-esp-"));
  try {
    const file = path.join(directory, "partitions.bin");
    const read = await runEsptool(tool, ["--port", port, "read_flash", "0x" + PARTITION_TABLE_OFFSET.toString(16), "0x" + PARTITION_TABLE_SIZE.toString(16), file], { signal, timeoutMs: 45000 });
    if (read.cancelled) partitions = { entries: [], valid: false, error: "已取消" };
    else if (read.code !== 0) partitions = { entries: [], valid: false, error: describeEsptoolFailure(read.output) };
    else partitions = parsePartitionTable(await fs.readFile(file));
  } finally {
    // Only this temporary directory, created by this call, is removed.
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  const notes: string[] = [];
  let security: EspSecurityFacts | null = null;
  const efuse = await siblingScript(tool, "espefuse.py");
  if (!efuse) notes.push("工具包中没有 espefuse.py，跳过 eFuse 安全状态读取");
  else {
    const summary = await runEsptool(efuse, ["--port", port, "summary"], { signal, timeoutMs: 60000 });
    if (summary.cancelled) notes.push("eFuse 读取已取消");
    else if (summary.code !== 0) notes.push("eFuse 读取失败：" + describeEsptoolFailure(summary.output));
    else security = parseEfuseSummary(summary.output);
  }

  return { ok: true, error: "", chip: parsed.chip, flash: parsed.flash, chipId: chip?.id ?? null, chipName: parsed.chip.name, revision: parsed.chip.revision, flashSize: parsed.flash?.size ?? null, partitions, security, notes: [...parsed.errors, ...notes] };
}

/**
 * Read-only identification for one explicitly chosen port. Never writes flash and never returns the MAC.
 */
export async function inspectEspDevice(port: string, tools?: ToolService, signal?: AbortSignal): Promise<EspInspectResult> {
  const started = Date.now();
  const empty = (error: string, tool = { executable: "", version: "", source: "" }): EspInspectResult => ({
    port, usb: null, usbClass: classifyUsb(null), board: { model: "unknown", note: "未读取到 USB 描述符；即使读到也不能确定板型。" },
    chip: null, flash: null, partitions: { entries: [], valid: false, error: "未读取", readBytes: 0 }, security: null, notes: [],
    tool, readOnly: true, error, checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
  });
  if (!port.trim()) return empty("请先选择端口");
  const usb = await usbDescriptorFor(port).catch(() => null);
  const usbClass = classifyUsb(usb);
  const found = await findEsptool(tools);
  if (!found.tool) return { ...empty(found.reason), usb, usbClass };
  const tool = found.tool;
  const version = await esptoolVersion(tool);
  const toolInfo = { executable: tool.executable, version, source: tool.source };
  try {
    return await withPort(port, "ESP 只读检测", async () => {
      const facts = await readDeviceFacts(tool, port, signal);
      if (!facts.ok || !facts.chip) return { ...empty(facts.error || "无法解析 esptool 输出"), usb, usbClass, tool: toolInfo };
      const chip = chipByKey(facts.chip.key);
      return {
        port, usb, usbClass,
        // A chip revision and a USB descriptor still do not identify the board model.
        board: { model: "unknown", note: "芯片与 USB 描述符都不能确定开发板型号；Aether 不会按板卡名推断烧录参数。" },
        chip: { ...facts.chip, id: chip?.id ?? null, family: chip?.family ?? "" },
        flash: facts.flash,
        partitions: { entries: facts.partitions.entries, valid: facts.partitions.valid, error: facts.partitions.error, readBytes: PARTITION_TABLE_SIZE },
        security: facts.security,
        notes: facts.notes,
        tool: toolInfo, readOnly: true, error: "", checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
      };
    });
  } catch (error) {
    return { ...empty(String(error)), usb, usbClass, tool: toolInfo };
  }
}
