import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SerialSessionLog, SERIAL_LOG_LIMITS, formatSerialLog, isNativeSerialTransport, truncateUtf8, utf8Bytes,
} from "../src/lib/serialLog";
import { SerialLogExportService, SERIAL_LOG_MAX_BYTES, serialLogSuggestedName } from "../desktop/serialLog";
import { EventEmitter } from "node:events";
import { SerialService } from "../desktop/plugins/serial";
import type { SerialPort } from "serialport";

// Focused checks for the bounded native serial session log and its narrow host export.
// No serial port, no Electron, no hardware: the log is fed decoded text directly.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aether-serial-log-"));
const info = { transportId: "native-serial", address: "COM_TEST", baudRate: "115200" };
try {
  const log = new SerialSessionLog();
  assert.equal(isNativeSerialTransport("native-serial"), true);
  assert.equal(isNativeSerialTransport("websocket"), false);
  assert.equal(log.prepare({ ...info, transportId: "websocket" }), -1, "WebSocket sessions never enter the log");
  assert.equal(log.snapshot(), null);
  assert.equal(log.addRx(-1, "ignored", 7), false);

  const first = log.prepare(info);
  log.addRx(first, "BOOT0\r\n", 7);
  assert.equal(log.snapshot(), null, "an uncommitted attempt must not replace a retained session");
  log.commit(first);
  log.addLifecycle(first, "已连接 " + info.address + " · " + info.baudRate + " baud");
  log.addRx(first, "温度 24.5°C 😀\n", utf8Bytes("温度 24.5°C 😀\n"));
  log.addTx(first, "hello\n", 6);
  let snapshot = log.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.info.address, info.address);
  assert.equal(snapshot.status, "connected");
  assert.deepEqual(snapshot.entries.map((entry) => entry.kind), ["rx", "lifecycle", "rx", "tx"]);
  assert.equal(snapshot.entries[2].text, "温度 24.5°C 😀\n", "decoded UTF-8 text is kept verbatim");
  assert.match(snapshot.entries[0].at, /^\d{4}-\d\d-\d\dT/, "each entry keeps an ISO timestamp");
  assert.equal(snapshot.rxBytes, 7 + utf8Bytes("温度 24.5°C 😀\n"));
  assert.equal(snapshot.txBytes, 6);

  const second = log.prepare(info);
  log.addRx(second, "attempt only\n", 13);
  assert.equal(log.snapshot()?.token, first, "an attempt does not replace the retained log");
  log.abort(second);
  assert.equal(log.snapshot()?.entries.length, 4, "a failed attempt leaves the retained log untouched");
  assert.equal(log.addRx(second, "late\n", 5), false, "an aborted token is inert");

  const third = log.prepare(info);
  log.addRx(third, "new session\n", 12);
  log.commit(third);
  assert.equal(log.snapshot()?.token, third, "a successful reconnect replaces the previous session");
  assert.deepEqual(log.snapshot()?.entries.map((entry) => entry.text), ["new session\n"]);
  assert.equal(log.addRx(first, "stale\n", 6), false, "callbacks from the replaced session are ignored");
  assert.equal(log.addTx(first, "stale\n", 6), false);

  log.addLifecycle(third, "连接已断开");
  log.ended(third, "disconnected");
  snapshot = log.snapshot();
  assert.equal(snapshot?.status, "disconnected");
  assert.ok(snapshot?.endedAt);
  assert.equal(log.addRx(third, "after end\n", 10), false, "callbacks after the session ends are ignored");
  assert.equal(log.snapshot()?.entries.length, 2, "the ended session stays exportable");
  console.log("PASS serial log: serial busy/error/retry, successful-reconnect replacement, stale tokens and native-only filtering");

  const bounded = new SerialSessionLog();
  const token = bounded.prepare(info); bounded.commit(token);
  const long = "🙂中".repeat(9000) + "tail";
  assert.ok(utf8Bytes(long) > SERIAL_LOG_LIMITS.maxEntryBytes);
  assert.equal(bounded.addRx(token, long, utf8Bytes(long)), true);
  const shortened = bounded.snapshot()!.entries[0].text;
  assert.ok(utf8Bytes(shortened) <= SERIAL_LOG_LIMITS.maxEntryBytes, "a single entry stays inside the UTF-8 bound");
  assert.match(shortened, /…（已截断）$/);
  assert.ok(!shortened.includes("\uFFFD"), "truncation never splits a surrogate pair");
  assert.equal(truncateUtf8("短", 1).text, "…（已截断）", "an impossible budget still returns valid text");
  assert.equal(bounded.snapshot()!.truncatedBytes, utf8Bytes(long) - utf8Bytes(shortened), "truncation reports the removed bytes");
  const split = new SerialSessionLog();
  const splitToken = split.prepare(info); split.commit(splitToken);
  assert.equal(split.addRx(splitToken, "", 2), true, "a split multibyte chunk still counts its bytes");
  split.addRx(splitToken, "温", 3);
  assert.equal(split.snapshot()!.rxBytes, 5, "RX bytes count split and complete chunks");
  assert.equal(split.snapshot()!.entries.filter((entry) => entry.kind === "rx").length, 1, "empty decoded text adds no blank entry");

  const rolling = new SerialSessionLog();
  const rollToken = rolling.prepare(info); rolling.commit(rollToken);
  for (let index = 0; index < 400; index++) rolling.addRx(rollToken, "x".repeat(1024) + String(index), 1025);
  const rolled = rolling.snapshot()!;
  const retained = rolled.entries.reduce((sum, entry) => sum + utf8Bytes(entry.text), 0);
  assert.ok(rolled.droppedEntries > 0, "history beyond the byte bound is dropped");
  assert.ok(rolled.droppedBytes > 0);
  assert.ok(retained <= SERIAL_LOG_LIMITS.maxBytes, "retained text stays inside the byte bound");
  assert.ok(rolled.entries.length <= SERIAL_LOG_LIMITS.maxEntries);
  assert.match(rolled.entries.at(-1)!.text, /399$/, "newest output survives");

  const counted = new SerialSessionLog();
  const countToken = counted.prepare(info); counted.commit(countToken);
  for (let index = 0; index <= SERIAL_LOG_LIMITS.maxEntries; index++) counted.addRx(countToken, String(index), String(index).length);
  assert.equal(counted.snapshot()!.entries.length, SERIAL_LOG_LIMITS.maxEntries);
  assert.equal(counted.snapshot()!.droppedEntries, 1);
  console.log("PASS serial log: per-entry and rolling UTF-8 bounds, explicit dropped counts");

  const overflow = new SerialSessionLog();
  const overToken = overflow.prepare(info); overflow.commit(overToken);
  overflow.addRx(overToken, "before overflow\n", 16);
  overflow.fail(overToken, "串口接收缓存已满，连接已停止，请降低输出频率后重连");
  const overflowSnapshot = overflow.snapshot()!;
  assert.equal(overflowSnapshot.backendOverflow, true);
  assert.equal(overflowSnapshot.status, "error");
  assert.equal(overflowSnapshot.entries.at(-1)!.kind, "error");
  assert.equal(overflowSnapshot.entries.at(-1)!.text, "串口接收缓存已满，连接已停止，请降低输出频率后重连");
  const overflowText = formatSerialLog(overflowSnapshot, { exportedAt: "2026-11-19T00:00:00.000Z" });
  assert.match(overflowText, /后端接收缓存溢出：是（连接已停止）/);
  assert.match(overflowText, /状态：错误/);
  assert.match(overflowText, /\] !! 串口接收缓存已满/);
  console.log("PASS serial log: error entries and the existing backend overflow marker");

  const formattedLog = new SerialSessionLog();
  const formattedToken = formattedLog.prepare(info); formattedLog.commit(formattedToken);
  formattedLog.addLifecycle(formattedToken, "已连接 COM_TEST · 115200 baud");
  formattedLog.addRx(formattedToken, "温度=24.5\n", 12);
  formattedLog.addTx(formattedToken, "status\n", 7);
  formattedLog.addLifecycle(formattedToken, "连接已断开");
  formattedLog.ended(formattedToken, "disconnected");
  const formatted = formatSerialLog(formattedLog.snapshot()!, { exportedAt: "2026-11-19T00:00:00.000Z" });
  assert.match(formatted, /^Aether Studio 串口诊断日志\n/);
  assert.match(formatted, /导出时间：2026-11-19T00:00:00\.000Z/);
  assert.match(formatted, /端口：COM_TEST/);
  assert.match(formatted, /波特率：115200/);
  assert.match(formatted, /状态：已断开/);
  assert.match(formatted, /发送：7 字节（只统计写入成功的 TX）/);
  assert.match(formatted, /已丢弃较早记录：无/);
  assert.match(formatted, /\] -- 已连接 COM_TEST/);
  assert.match(formatted, /\] RX 温度=24\.5/);
  assert.match(formatted, /\] TX status/);
  assert.match(formatted, /\] -- 连接已断开/);
  assert.match(formatted, /不包含固件、凭证或设备 MAC/);
  assert.equal(formatted.includes("password"), false);
  const droppedText = formatSerialLog(rolled, { exportedAt: "2026-11-19T00:00:00.000Z" });
  assert.match(droppedText, /已丢弃较早记录：\d+ 条 \/ \d+ 字节/);
  assert.match(droppedText, /!! 已丢弃较早记录/);
  assert.match(droppedText, /\] RX /);
  console.log("PASS serial log: exported text states session facts, markers and dropped history");

  const discarded = new SerialSessionLog();
  const discardToken = discarded.prepare(info); discarded.commit(discardToken);
  discarded.addRx(discardToken, "project A\n", 10);
  assert.equal(discarded.discard(), true);
  assert.equal(discarded.snapshot(), null);
  assert.equal(discarded.addRx(discardToken, "stale after switch\n", 19), false);
  assert.equal(discarded.discard(), false);
  console.log("PASS serial log: a project switch discards the retained session and its stale callbacks");

  // ---- host export: picker-issued new file only, cancel, no overwrite, invalidation ----
  const exportsDir = path.join(root, "exports");
  await fs.mkdir(exportsDir);
  const service = new SerialLogExportService();
  const target = path.join(exportsDir, "session.txt");
  let picked = "";
  const saved = await service.save({ suggestedName: "aether-serial-COM_TEST-20261119-000000.txt", text: "hello 世界\n", sessionId: "1" }, async (name) => { picked = name; return target; });
  assert.deepEqual(saved, { status: "saved", path: target });
  assert.equal(await fs.readFile(target, "utf8"), "hello 世界\n");
  assert.equal(picked, "aether-serial-COM_TEST-20261119-000000.txt", "the picker receives the suggested name");

  const cancelledPath = path.join(exportsDir, "cancelled.txt");
  const cancelled = await service.save({ suggestedName: "cancelled.txt", text: "x", sessionId: "1" }, async () => null);
  assert.deepEqual(cancelled, { status: "cancelled", reason: "picker" });
  assert.equal(await fs.stat(cancelledPath).then(() => true, () => false), false);

  const keep = path.join(exportsDir, "keep.txt");
  await fs.writeFile(keep, "KEEP");
  const overwrite = await service.save({ suggestedName: "keep.txt", text: "REPLACEMENT", sessionId: "1" }, async () => keep);
  assert.deepEqual(overwrite, { status: "failed", error: "目标文件已存在，未覆盖" });
  assert.equal(await fs.readFile(keep, "utf8"), "KEEP", "an existing file is never truncated");

  let release!: (value: string | null) => void;
  const pending = service.save({ suggestedName: "pending.txt", text: "old session", sessionId: "1" }, () => new Promise<string | null>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  service.invalidate();
  const invalidatedPath = path.join(exportsDir, "invalidated.txt");
  release(invalidatedPath);
  assert.deepEqual(await pending, { status: "cancelled", reason: "invalidated" }, "a session change invalidates the open picker");
  assert.equal(await fs.stat(invalidatedPath).then(() => true, () => false), false, "an invalidated picker writes nothing");

  const racing = service.save({ suggestedName: "racing.txt", text: "race", sessionId: "1" }, () => new Promise<string | null>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await service.save({ suggestedName: "second.txt", text: "second", sessionId: "1" }, async () => path.join(exportsDir, "second.txt")), { status: "failed", error: "已有导出选择框正在打开" });
  release(null);
  assert.deepEqual(await racing, { status: "cancelled", reason: "picker" });

  let pickerCalls = 0;
  const oversize = await service.save({ suggestedName: "big.txt", text: "x".repeat(SERIAL_LOG_MAX_BYTES + 1), sessionId: "1" }, async () => { pickerCalls++; return path.join(exportsDir, "big.txt"); });
  assert.equal(oversize.status, "failed");
  assert.match((oversize as { error: string }).error, /上限/);
  assert.equal(pickerCalls, 0, "oversized text never opens a picker");
  assert.deepEqual(await service.save({ suggestedName: "empty.txt", text: "", sessionId: "1" }, async () => { pickerCalls++; return null; }), { status: "failed", error: "日志内容为空，未导出" });
  assert.equal(pickerCalls, 0);

  const retryPath = path.join(exportsDir, "retry.txt");
  const retried = await service.save({ suggestedName: "retry.txt", text: "after failure", sessionId: "1" }, async () => retryPath);
  assert.deepEqual(retried, { status: "saved", path: retryPath }, "a refused overwrite can be retried with a new path");
  assert.equal(await fs.readFile(retryPath, "utf8"), "after failure");

  assert.equal(serialLogSuggestedName("a/b"), "aether-serial-log.txt");
  assert.equal(serialLogSuggestedName("COM3.txt"), "COM3.txt");
  assert.equal(serialLogSuggestedName("session"), "session.txt");
  assert.ok(serialLogSuggestedName("x".repeat(400)).length <= 124);
  assert.match(serialLogSuggestedName("x".repeat(400)), /\.txt$/);
  assert.equal(serialLogSuggestedName("a" + String.fromCharCode(92) + "b"), "aether-serial-log.txt", "a backslash never becomes a path component");
  console.log("PASS serial log export: saved/cancelled/failed results, no overwrite, pending-picker invalidation");
  const store = await import("../src/store/serialLog");
  store.trackProjectRoot("project-a");
  const projectToken = store.serialSessionLog.prepare(info);
  store.serialSessionLog.commit(projectToken);
  store.serialSessionLog.addRx(projectToken, "project A\n", 10);
  assert.ok(store.serialSessionLog.snapshot());
  store.trackProjectRoot("project-a");
  assert.ok(store.serialSessionLog.snapshot(), "reopening the same root keeps the retained log");
  store.trackProjectRoot("project-b");
  assert.equal(store.serialSessionLog.snapshot(), null, "an actual project switch discards the retained log");
  store.serialSessionLog.addRx(projectToken, "late\n", 5);
  assert.equal(store.serialSessionLog.snapshot(), null, "late callbacks stay inert after a project switch");
  console.log("PASS serial log: the renderer root subscription discards only on an actual switch");
  // Real SerialService propagation: a filled receive buffer keeps its real error for the next poll.
  class FakePort extends EventEmitter {
    isOpen = false; opening = false;
    open(callback: (error?: Error) => void) { this.isOpen = true; callback(); }
    close(callback?: (error?: Error) => void) { this.isOpen = false; this.emit("close"); callback?.(); }
    write(_data: unknown, callback: (error?: Error) => void) { callback(); }
    drain(callback: (error?: Error) => void) { callback(); }
  }
  const fakePort = new FakePort();
  const serialService = new SerialService(() => fakePort as unknown as SerialPort);
  const sessionEvents: boolean[] = [];
  serialService.setOnSessionEnd((opened) => sessionEvents.push(opened));
  const sessionId = await serialService.open("COM_FAKE", 115200);
  fakePort.emit("data", Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(() => serialService.read(sessionId), /接收缓存已满/, "the overflow reason survives endSession");
  assert.deepEqual(sessionEvents, [true], "an opened session reports that it had opened the port");
  assert.equal(serialService.isOpen(), false);
  console.log("PASS serial service: a receive-buffer overflow reaches the next poll as the real error");

  // A pending export is invalidated by a successful reconnect (commit), not only by a disconnect.
  const invalidations: string[] = [];
  let releaseSave!: (value: unknown) => void;
  class StoreWindow {}
  (globalThis as unknown as { window?: unknown }).window = {
    aether: { runtime: "electron", serialLog: { save: () => new Promise((resolve) => { releaseSave = resolve; }), invalidate: async () => { invalidations.push("invalidate"); } } },
  };
  const exportToken = store.serialSessionLog.prepare(info); store.serialSessionLog.commit(exportToken); store.serialSessionLog.addRx(exportToken, "export-data", 11);
  const exporting = store.exportSerialLog();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacementToken = store.serialSessionLog.prepare(info); store.serialSessionLog.commit(replacementToken);
  assert.deepEqual(invalidations, ["invalidate"], "a successful reconnect invalidates the pending picker");
  releaseSave({ status: "cancelled", reason: "invalidated" });
  assert.deepEqual(await exporting, { status: "cancelled", reason: "invalidated" });
  delete (globalThis as unknown as { window?: unknown }).window;
  console.log("PASS serial log: a successful reconnect invalidates an open export picker");

} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log("PASS serial log: all focused checks completed");
