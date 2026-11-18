import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkUploadAgainstPlan, evaluatePreflight, type EspPlannedSegment, type EspPreflightResult } from "../../shared/esp";
import { findEsptool, runEsptool, type EsptoolTool } from "./esptool";
import { readDeviceFacts } from "./inspect";
import { readEspProject, type EspProjectFacts } from "./project";
import { applyBuildRecord, buildPreflightInput } from "./preflight";
import { platformioEnvironments } from "../plugins/platformio";
import type { TaskProvider } from "../tasks";
import type { ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";

// The ESP upload provider is the only place that writes flash. Every fact it acts on is derived here:
// project config, board manifest, build artifacts and the live device. Renderer options select the
// port and environment only; there is no option that can relax a check or skip the journal.

const READ_BAUD = "230400";
const ALIGN = 0x1000;
const hex = (value: number) => "0x" + value.toString(16).toUpperCase();

export interface EspWriteJournal {
  directory: string;
  port: string; environment: string; chipName: string; flashSize: number | null;
  ranges: Array<{ offset: number; size: number; file: string; sha256: string }>;
  totalBytes: number; createdAt: string;
}

/** Merges and 4KB-aligns the planned write ranges; those are exactly the sectors that will be erased. */
export function writeRanges(segments: Array<Pick<EspPlannedSegment, "offset" | "size">>) {
  const ranges = segments.map((segment) => ({ offset: Math.floor(segment.offset / ALIGN) * ALIGN, end: Math.ceil((segment.offset + segment.size) / ALIGN) * ALIGN })).sort((a, b) => a.offset - b.offset);
  const merged: Array<{ offset: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.offset <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged.map((range) => ({ offset: range.offset, size: range.end - range.offset }));
}

async function readChunk(tool: EsptoolTool, port: string, offset: number, size: number, file: string, signal?: AbortSignal): Promise<string> {
  const run = await runEsptool(tool, ["--port", port, "--baud", READ_BAUD, "read_flash", hex(offset), hex(size), file], { signal, timeoutMs: 240000 });
  if (run.cancelled) throw new Error("已取消");
  if (run.code !== 0) throw new Error("读取 " + hex(offset) + " 失败：" + (run.output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ") || "退出码 " + run.code));
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/**
 * Reads the head sectors the write will erase (bootloader, partition table, boot_app0) once. The app
 * region is the intended target and is not re-read here. esptool verifies each read against the flash
 * digest, and a failed read refuses the upload. The read is deliberately short so the pre-task phase
 * stays interactive; full-image backups belong to the Flash 备份 panel.
 */
async function snapshot(tool: EsptoolTool, port: string, ranges: Array<{ offset: number; size: number }>, directory: string, signal: AbortSignal | undefined, log: (line: string) => void): Promise<EspWriteJournal["ranges"]> {
  await fs.mkdir(directory, { recursive: true });
  const result: EspWriteJournal["ranges"] = [];
  for (const range of ranges) {
    let finisher: string | null = null;
    for (let attempt = 1; attempt <= 2 && !finisher; attempt++) {
      log("[aether] 写前快照 " + hex(range.offset) + " + " + hex(range.size) + "（第 " + attempt + " 次尝试）");
      try { finisher = await readChunk(tool, port, range.offset, range.size, path.join(directory, hex(range.offset) + ".bin"), signal); }
      catch (error) { log("[aether] 读取失败：" + String(error instanceof Error ? error.message : error)); }
    }
    if (!finisher) throw new Error("写前快照读取失败（" + hex(range.offset) + "/" + hex(range.size) + "），已拒绝写入");
    result.push({ offset: range.offset, size: range.size, file: hex(range.offset) + ".bin", sha256: finisher });
  }
  return result;
}

/** Absolute paths so esptool never resolves a file relative to the wrong directory. */
const absolute = (facts: EspProjectFacts, file: string) => file === "boot_app0.bin" ? facts.bootApp0!.file : path.join(facts.buildDirectory, file);

/**
 * The exact esptool command PlatformIO itself would run, built from the board manifest values that
 * were just verified. Any unknown parameter refuses instead of guessing.
 */
export function esptoolUploadArgs(facts: EspProjectFacts, port: string, segments: EspPlannedSegment[]): string[] {
  const write = facts.writeArgs;
  if (!write) throw new Error("无法确定标准 esptool 烧录参数：" + facts.writeArgsProblem);
  return [
    "--chip", write.chip, "--port", port, "--baud", write.baud, "--before", write.before, "--after", write.after,
    "write_flash", "-z", "--flash_mode", write.flashMode, "--flash_freq", write.flashFreq, "--flash_size", write.flashSize,
    ...segments.flatMap((segment) => [hex(segment.offset), absolute(facts, segment.file)]),
  ];
}

export interface EspUploadProviderOptions {
  /** Journals live outside the project, under the application data directory. */
  journalRoot: () => string;
}

export function createEspUploadProvider(tools: ToolService, workspace: WorkspaceService, options: EspUploadProviderOptions): TaskProvider {
  let plannedSegments: EspPlannedSegment[] = [];
  return {
    id: "esp.upload",
    kind: "esp-upload",
    // Keep the build record intact: the preflight binds to it, so the upload keeps its own record.
    recordName: "esp-upload.json",
    // The real executable is resolved inside prepare(); this placeholder is never spawned.
    executable: () => "esptool",
    args: () => { throw new Error("esp.upload 的参数在写入前核对阶段生成"); },
    portOption: "port",
    environments: (root) => platformioEnvironments(root, tools.executable("platformio")),
    async prepare(root, _executable, opts, signal, log) {
      const port = opts.port?.trim();
      if (!port) throw new Error("请明确选择烧录端口");
      const environment = opts.environment?.trim();
      if (!environment) throw new Error("未选择 PlatformIO 构建环境");

      // 1. Read the project and the exact build this app recorded.
      const facts = await readEspProject(root, environment, tools.executable("platformio"), tools, workspace);
      if (!facts.supported) throw new Error(facts.skipped || "该工程不是 ESP 目标");
      if (!facts.writeArgs) throw new Error("无法确定标准 esptool 烧录参数：" + facts.writeArgsProblem);

      // 2. Verify against the live device while the port lease is held for the rest of the task.
      const found = await findEsptool(tools);
      if (!found.tool) throw new Error(found.reason);
      const tool = found.tool;
      const device = await readDeviceFacts(tool, port, signal);
      if (!device.ok) throw new Error("无法读取设备：" + device.error);
      const result: EspPreflightResult = applyBuildRecord(evaluatePreflight(buildPreflightInput(facts, port, device)), facts);
      const blocks = result.findings.filter((finding) => finding.severity === "block");
      if (blocks.length) throw new Error("部署前核对未通过，未写入任何数据：\n" + blocks.map((finding) => "- " + finding.title + "：" + finding.next).join("\n"));

      // 3. Journal the head sectors the write will erase (a short, verified read); fail closed otherwise.
      const ranges = writeRanges(result.segments.filter((segment) => segment.name !== "app"));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const directory = path.join(options.journalRoot(), "write-" + port.replace(/[^A-Za-z0-9]+/g, "") + "-" + stamp);
      // A journal inside the project would change its fingerprint and could be committed by mistake.
      const relative = path.relative(path.resolve(root), path.resolve(directory));
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("写前快照目录不能位于工程目录内：" + directory);
      const journal: EspWriteJournal = {
        directory, port, environment, chipName: device.chipName, flashSize: device.flashSize,
        ranges: await snapshot(tool, port, ranges, directory, signal, log),
        totalBytes: ranges.reduce((total, range) => total + range.size, 0), createdAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(directory, "journal.json"), JSON.stringify({ ...journal, preflight: result }, null, 2));
      plannedSegments = result.segments;
      return { executable: tool.executable, args: [...tool.prefix, ...esptoolUploadArgs(facts, port, result.segments)], metadata: { espPreflight: result, journal } };
    },
    async artifacts(_root, _executable, opts) {
      const files = ["firmware.bin", "bootloader.bin", "partitions.bin"].map((name) => ".pio/build/" + (opts.environment ?? "") + "/" + name);
      return files;
    },
    async verify(task) {
      // Defense in depth: compare the command that actually ran with the plan that was verified.
      return { writeCheck: checkUploadAgainstPlan(task.log, plannedSegments) };
    },
  };
}
