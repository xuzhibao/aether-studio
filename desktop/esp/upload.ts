import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkUploadAgainstPlan, evaluatePreflight, type EspPlannedSegment, type EspPreflightResult } from "../../shared/esp";
import { findEsptool, runEsptool, type EsptoolTool } from "./esptool";
import { bindDeployExpectation, deploymentPlanDigest, enforceSimulationGate, type EspSimulationGate, type VerifiedDeployIntent } from "./deployGate";
import { reverifyAppOnlyTarget, verifyAppOnlyTarget, type EspAppOnlyTarget } from "./appOnly";
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

/** One verified host file copied into the private write snapshot. `file` is what esptool will read. */
export interface EspSnapshotFile { name: string; source: string; file: string; size: number; sha256: string }

/**
 * Copies every planned segment into a private directory outside the project and re-hashes each copy.
 * esptool is then pointed at these copies, so a workspace file changed after the preflight can change
 * neither what was checked nor what is written. boot_app0 is included even though it usually lives in
 * the framework package rather than the project's build directory.
 */
async function materializeInputSnapshot(facts: EspProjectFacts, segments: EspPlannedSegment[], directory: string, log: (line: string) => void): Promise<EspSnapshotFile[]> {
  const sources = new Map<string, string>();
  for (const segment of segments) {
    const name = path.basename(segment.file);
    if (!name || name === "." || name === "..") throw new Error("写入计划包含无效文件名：" + segment.file);
    if (sources.has(name)) throw new Error("写入计划中文件名重复：" + name + "；无法建立无歧义的私有快照。");
    const source = segment.name === "boot_app0" ? facts.bootApp0?.file : path.join(facts.buildDirectory, name);
    if (!source) throw new Error("预检计划包含 boot_app0，但找不到 boot_app0.bin 的实际路径");
    sources.set(name, source);
  }
  const files: EspSnapshotFile[] = [];
  for (const segment of segments) {
    const name = path.basename(segment.file);
    const source = sources.get(name)!;
    const destination = path.join(directory, name);
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o600).catch(() => {});
    const bytes = await fs.readFile(destination);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== segment.size || sha256 !== segment.sha256) {
      throw new Error("写前输入快照与预检不一致：" + name + "（快照 " + bytes.length + " 字节 / " + sha256 + "，预检 " + segment.size + " 字节 / " + segment.sha256 + "）。已拒绝写入。");
    }
    files.push({ name, source, file: destination, size: bytes.length, sha256 });
  }
  log("[aether] 私有写入快照已建立并核对 SHA-256：" + files.map((file) => file.name).join("、"));
  return files;
}

/**
 * The exact esptool command PlatformIO itself would run, built from the board manifest values that
 * were just verified. Files are the private snapshot copies, never the workspace originals.
 */
export function esptoolUploadArgs(facts: EspProjectFacts, port: string, segments: EspPlannedSegment[], files: EspSnapshotFile[]): string[] {
  const write = facts.writeArgs;
  if (!write) throw new Error("无法确定标准 esptool 烧录参数：" + facts.writeArgsProblem);
  const byName = new Map(files.map((file) => [file.name, file.file]));
  return [
    "--chip", write.chip, "--port", port, "--baud", write.baud, "--before", write.before, "--after", write.after,
    "write_flash", "-z", "--flash_mode", write.flashMode, "--flash_freq", write.flashFreq, "--flash_size", write.flashSize,
    ...segments.flatMap((segment) => {
      const file = byName.get(path.basename(segment.file));
      if (!file) throw new Error("没有为写入段建立私有快照：" + segment.file);
      return [hex(segment.offset), file];
    }),
  ];
}

export interface EspUploadProviderOptions {
  /** Journals live outside the project, under the application data directory. */
  journalRoot: () => string;
  /** Private input snapshots live here; defaults to the OS temp directory. Tests inject a directory. */
  snapshotRoot?: () => string;
  /**
   * Optional host-trusted simulation gate. Only host code can supply it (main.ts), and it is evaluated
   * after the private snapshot exists and before esptool starts. Without this option the deploy keeps
   * its previous behaviour exactly; a refused gate throws, so flash receives zero bytes.
   */
  simulation?: EspSimulationGate;
  /**
   * Host-only write intent. Only a task started by the explicit verified-deploy commit carries the
   * opaque task option this callback looks up; a generic deploy gets null and keeps the full plan.
   * The lookup consumes the one-shot intent, so a retry or a second task has nothing to reuse.
   */
  writeIntent?: (options: Record<string, string>) => VerifiedDeployIntent | null;
}

export function createEspUploadProvider(tools: ToolService, workspace: WorkspaceService, options: EspUploadProviderOptions): TaskProvider {
  let plannedSegments: EspPlannedSegment[] = [];
  let cleanupInputs: (() => Promise<void>) | null = null;
  const discardInputs = async () => { const cleanup = cleanupInputs; cleanupInputs = null; if (cleanup) await cleanup(); };
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
    // Whatever the outcome (success, failure, cancellation or a failed prepare), the private copies go away.
    async afterRun() { await discardInputs(); },
    async prepare(root, _executable, opts, signal, log) {
      await discardInputs().catch(() => {});
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

      // 2b. Host-selected write intent. Only the explicit verified-deploy commit can supply it; it
      // narrows the plan to the single app segment in the OTA slot the bootloader will really boot.
      // The full preflight above already passed without any bypass.
      const intent = options.writeIntent ? options.writeIntent(opts) : null;
      const appOnly = intent !== null;
      let planSegments = result.segments;
      let appOnlyTarget: EspAppOnlyTarget | null = null;

      // 3. Journal the sectors the write will erase (a short, verified read); fail closed otherwise.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const directory = path.join(options.journalRoot(), "write-" + port.replace(/[^A-Za-z0-9]+/g, "") + "-" + stamp);
      // A journal inside the project would change its fingerprint and could be committed by mistake.
      const relative = path.relative(path.resolve(root), path.resolve(directory));
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("写前快照目录不能位于工程目录内：" + directory);
      if (appOnly) {
        // The identity reads need the scratch directory before the journal snapshot is taken.
        await fs.mkdir(directory, { recursive: true });
        const appSegments = result.segments.filter((segment) => segment.name === "app");
        if (appSegments.length !== 1) throw new Error("app-only 计划必须恰好包含一个 app 段（" + appSegments.length + "）。未写入任何数据。");
        appOnlyTarget = await verifyAppOnlyTarget({ tool, port, directory, signal, device, project: facts, appOffset: appSegments[0].offset, appSize: appSegments[0].size, appSha256: appSegments[0].sha256 });
        planSegments = [appSegments[0]];
        log("[aether] app-only 计划：槽 " + appOnlyTarget.partition.label + "@" + hex(appOnlyTarget.partition.offset) + "，擦除 " + hex(appOnlyTarget.erase.offset) + "+" + hex(appOnlyTarget.erase.size) + "，OTA seq=" + appOnlyTarget.otadata.activeSeq + "，bootloader IDF " + appOnlyTarget.bootloaderVersion.raw + "，app IDF " + appOnlyTarget.appIdfVersion.raw);
        // The preview is the only write authorization. Re-prove that the target the live device just
        // showed is still the one the user previewed before the private snapshot or gate is accepted.
        const wanted = options.writeIntent ? intent : null;
        if (!wanted) throw new Error("缺少已验证写入目标。未写入任何数据。");
        const same = (label: string, actual: string, expected: string) => { if (actual !== expected) throw new Error("已验证写入预览已失效：" + label + " 已变化。未写入任何数据。"); };
        same("工程目录", path.resolve(root), path.resolve(wanted.root));
        same("端口", String(port).trim().toUpperCase(), String(wanted.port).trim().toUpperCase());
        same("环境", environment, wanted.environment);
        same("app SHA-256", appSegments[0].sha256.toLowerCase(), wanted.appSha256.toLowerCase());
        same("活动槽", appOnlyTarget.partition.label + "@" + hex(appOnlyTarget.partition.offset) + "/" + hex(appOnlyTarget.partition.size), wanted.slot.label + "@" + hex(wanted.slot.offset) + "/" + hex(wanted.slot.size));
        same("擦除范围", hex(appOnlyTarget.erase.offset) + "+" + hex(appOnlyTarget.erase.size), hex(wanted.erase.offset) + "+" + hex(wanted.erase.size));
      }
      const ranges = appOnly ? writeRanges(planSegments) : writeRanges(result.segments.filter((segment) => segment.name !== "app"));
      if (appOnlyTarget && (ranges.length !== 1 || ranges[0].offset !== appOnlyTarget.erase.offset || ranges[0].size !== appOnlyTarget.erase.size)) throw new Error("app-only 擦除范围与已核对目标不一致。未写入任何数据。");
      const journal: EspWriteJournal = {
        directory, port, environment, chipName: device.chipName, flashSize: device.flashSize,
        ranges: await snapshot(tool, port, ranges, directory, signal, log),
        totalBytes: ranges.reduce((total, range) => total + range.size, 0), createdAt: new Date().toISOString(),
      };
      // Copy and re-verify the exact bytes esptool will write. This is last so the window between the
      // check and the write is as small as possible; a change after the copy cannot affect the write.
      const snapshotRoot = options.snapshotRoot?.() ?? os.tmpdir();
      await fs.mkdir(snapshotRoot, { recursive: true });
      const inputDirectory = await fs.mkdtemp(path.join(snapshotRoot, "aether-esp-input-"));
      cleanupInputs = () => fs.rm(inputDirectory, { recursive: true, force: true });
      try {
        const relativeInputs = path.relative(path.resolve(root), path.resolve(inputDirectory));
        if (!relativeInputs.startsWith("..") && !path.isAbsolute(relativeInputs)) throw new Error("私有写入快照目录不能位于工程目录内：" + inputDirectory);
        const inputFiles = await materializeInputSnapshot(facts, planSegments, inputDirectory, log);
        // 4. Optional host gate: the exact app bytes esptool will write must be the ones that passed
        // simulation. It runs while the port lease is held and before any process exists, so a refusal
        // cancels the task with zero flash writes; the private snapshots are discarded by afterRun().
        let simulation: { appSha256: string; planSha256: string; source: string; recordedAt: string } | null = null;
        if (options.simulation) {
          const accepted = await enforceSimulationGate(options.simulation, async () => {
            const inputHash = await workspace.fingerprint().catch(() => "");
            return bindDeployExpectation({ port, environment, inputHash, segments: planSegments, snapshots: inputFiles });
          }, log, opts);
          if (accepted) simulation = {
            appSha256: accepted.appSha256.toLowerCase(),
            planSha256: deploymentPlanDigest(port, environment, planSegments),
            source: accepted.source, recordedAt: accepted.recordedAt,
          };
        }
        if (appOnly && !simulation) throw new Error("app-only 模式要求宿主签发的同镜像凭据，当前未提供或未生效。未写入任何数据。");
        if (appOnly && appOnlyTarget) {
          const appFile = inputFiles.find((file) => file.name === path.basename(planSegments[0].file));
          if (!appFile) throw new Error("app-only 私有快照缺失。未写入任何数据。");
          await reverifyAppOnlyTarget({ tool, port, directory, signal, target: appOnlyTarget, appFile: appFile.file });
        }
        const appOnlyRecord = appOnlyTarget ? {
          mode: "app-only" as const,
          target: { label: appOnlyTarget.partition.label, offset: appOnlyTarget.appOffset, size: appOnlyTarget.appSize, erase: appOnlyTarget.erase },
          otadata: { activeIndex: appOnlyTarget.otadata.activeIndex, activeSeq: appOnlyTarget.otadata.activeSeq, activeSlot: appOnlyTarget.otadata.activeSlot, activeState: appOnlyTarget.otadata.activeState },
          bootloader: appOnlyTarget.bootloaderVersion.raw, appIdf: appOnlyTarget.appIdfVersion.raw,
          findings: appOnlyTarget.findings,
        } : null;
        await fs.writeFile(path.join(directory, "journal.json"), JSON.stringify({ ...journal, inputs: inputFiles, preflight: result, ...(appOnlyRecord ? { appOnly: appOnlyRecord } : {}) }, null, 2));
        plannedSegments = planSegments;
        return {
          executable: tool.executable,
          args: [...tool.prefix, ...esptoolUploadArgs(facts, port, planSegments, inputFiles)],
          metadata: { espPreflight: result, journal, inputSnapshot: { directory: inputDirectory, files: inputFiles }, ...(simulation ? { simulation } : {}), ...(appOnlyRecord ? { appOnly: appOnlyRecord } : {}) },
        };
      } catch (error) {
        await discardInputs().catch(() => {});
        throw error;
      }
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
