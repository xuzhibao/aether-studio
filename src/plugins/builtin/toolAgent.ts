import type { AIMessage, AgentResult, PluginAPI } from "../api";
import type { EditProposal, ToolRun } from "../../types";

export async function runToolAgent(api: PluginAPI, project: Parameters<import("../api").CapabilityMap["agents"]["run"]>[0], history: AIMessage[], signal?: AbortSignal, onTool?: (run: ToolRun) => void): Promise<AgentResult> {
  const provider = api.capabilities.require("providers", "openai-compatible");
  const tools = api.capabilities.all("tools");
  const messages: AIMessage[] = [{ role: "system", content: "你是 Aether Studio 工程助手。可以调用当前提供的工程工具。提出文件修改仅生成待审阅建议，用户应用前文件不会改变。不能宣称做过编译、电气校验、真实仿真、部署或硬件操作。Demo Simulation 只生成数据。当前工程：" + JSON.stringify({ project: project.project, files: Object.keys(project.files), capabilities: project.capabilities, componentCount: project.components.length }) }, ...history];
  const runs: ToolRun[] = [];
  const proposals: EditProposal[] = [];
  for (let turn = 0; turn < 6; turn++) {
    signal?.throwIfAborted();
    const reply = await provider.chat(messages, tools, signal);
    if (!reply.tool_calls?.length) return { text: reply.content ?? "API 返回了空回复。", toolRuns: runs, proposals };
    messages.push(reply);
    for (const call of reply.tool_calls) {
      signal?.throwIfAborted();
      let output: unknown;
      let status: ToolRun["status"] = "done";
      try {
        const tool = tools.find((tool) => tool.id === call.function.name);
        if (!tool) throw new Error("未提供的工程工具：" + call.function.name);
        // Resolve again so a disabled plugin cannot execute a retained function.
        const result = await api.capabilities.require("tools", tool.id).execute(JSON.parse(call.function.arguments), project);
        signal?.throwIfAborted();
        output = result.output;
        if (result.proposal) proposals.push(result.proposal);
      } catch (error) {
        signal?.throwIfAborted();
        status = "error";
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      const run: ToolRun = { id: call.id, name: call.function.name, status, detail: JSON.stringify(output) };
      runs.push(run); onTool?.(run); api.events.emit("agent:tool", run);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  return { text: "已达到 6 轮工具调用限制，当前结果和待审阅修改已保留。可以继续提出更具体的要求。", toolRuns: runs, proposals };
}
