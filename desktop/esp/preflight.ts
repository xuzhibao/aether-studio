import { evaluatePreflight, unsupportedPreflight, type EspPreflightInput, type EspPreflightResult } from "../../shared/esp";
import { findEsptool } from "./esptool";
import { readDeviceFacts, type EspDeviceFacts } from "./inspect";
import { readEspProject, type EspProjectFacts } from "./project";
import { withPort } from "../portLease";
import type { ToolService } from "../tools";
import type { WorkspaceService } from "../workspace";

export interface EspPreflightOptions {
  root: string;
  environment?: string;
  port: string;
  platformio: string;
  workspace: WorkspaceService;
  tools?: ToolService;
  signal?: AbortSignal;
}

const NONE: EspDeviceFacts = { ok: false, error: "未读取设备", chip: null, flash: null, chipId: null, chipName: "", revision: "", flashSize: null, partitions: { entries: [], valid: false, error: "未读取" }, security: null, notes: [] };

/** The single mapping from raw facts to the preflight input; the provider and the UI share it. */
export function buildPreflightInput(facts: EspProjectFacts, port: string, device: EspDeviceFacts): EspPreflightInput {
  return {
    port, environment: facts.environment,
    chip: { expectedId: facts.expectedId, expectedMcu: facts.mcu || facts.board, expectedSource: facts.mcuSource, detectedId: device.chipId, detectedName: device.chipName, detectedRevision: device.revision },
    flash: { declared: facts.flashDeclared, declaredSource: facts.flashSource, detected: device.flashSize },
    images: {
      app: { file: "firmware.bin", size: facts.app.size, sha256: facts.app.sha256, chipId: facts.app.chipId, valid: facts.app.valid, error: facts.app.error },
      bootloader: { file: "bootloader.bin", size: facts.bootloader.size, sha256: facts.bootloader.sha256, chipId: facts.bootloader.chipId, valid: facts.bootloader.valid },
      partitions: { file: "partitions.bin", size: facts.partitions.size, sha256: facts.partitions.sha256, entries: facts.partitions.table.entries, valid: facts.partitions.table.valid, error: facts.partitions.table.error },
      bootApp0: facts.bootApp0 ? { file: facts.bootApp0.file.split(/[\\/]/).pop() ?? "boot_app0.bin", size: facts.bootApp0.facts.size, sha256: facts.bootApp0.facts.sha256 } : null,
      missing: facts.missing,
    },
    layout: { appOffset: facts.appOffset, appOffsetSource: facts.appOffsetSource, bootloaderOffset: facts.bootloaderOffset, partitionOffset: facts.partitionOffset, bootApp0Offset: facts.bootApp0Offset },
    device: { ok: device.ok, error: device.error, partitions: device.partitions, security: device.security },
    upload: { protocol: facts.uploadProtocol, parseable: !facts.unparseable, reason: facts.unparseable },
  };
}

/** Build-record binding: the plan must describe the images that will actually be written. */
export function applyBuildRecord(result: EspPreflightResult, facts: EspProjectFacts): EspPreflightResult {
  const extra: EspPreflightResult["findings"] = [];
  if (facts.recordProblem) extra.push({ id: "build-record", severity: "block", title: "无法绑定到最近一次构建", detail: facts.recordProblem + "；预检结果可能对应不上真正要写入的产物。", next: "在 Build Tasks 里重新构建当前环境，再点部署。" });
  if (facts.staleArtifacts.length) extra.push({ id: "artifact-changed", severity: "block", title: "构建产物在构建后发生了变化", detail: "以下文件与构建记录中的 SHA-256 不一致：" + facts.staleArtifacts.join("、") + "。", next: "重新构建当前环境后再部署，避免写入与预检不一致的镜像。" });
  return extra.length ? { ...result, ok: false, findings: [...result.findings, ...extra] } : result;
}

/** Reads the project and the device, then evaluates. Read-only; used by the UI and by the provider. */
export async function collectPreflight(facts: EspProjectFacts, port: string, tools: ToolService | undefined, signal?: AbortSignal): Promise<{ result: EspPreflightResult; device: EspDeviceFacts; tool: string; toolSource: string }> {
  const found = await findEsptool(tools);
  const device = found.tool
    ? await withPort(port, "ESP 部署核对", () => readDeviceFacts(found.tool!, port, signal))
    : { ...NONE, error: found.reason };
  const result = applyBuildRecord(evaluatePreflight(buildPreflightInput(facts, port, device)), facts);
  return { result, device, tool: found.tool?.version ?? "", toolSource: found.tool?.source ?? "" };
}

/** UI preview. It never gates the write; the upload provider re-runs the same checks itself. */
export async function preflightEspUpload(options: EspPreflightOptions): Promise<EspPreflightResult> {
  const port = options.port.trim();
  if (!port) return unsupportedPreflight("未选择端口", "", options.environment ?? "");
  const facts = await readEspProject(options.root, options.environment, options.platformio, options.tools, options.workspace);
  if (!facts.supported) return unsupportedPreflight(facts.skipped, port, facts.environment);
  const { result } = await collectPreflight(facts, port, options.tools, options.signal);
  return result;
}
