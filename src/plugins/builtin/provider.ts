import { runToolAgent } from "./toolAgent";
import type { AIMessage, CapabilityMap, PluginAPI, ProviderTestResult, StudioPlugin } from "../api";

export function openAICompatibleProvider(api: PluginAPI) {
  const settings = () => ({ endpoint: api.settings.get("endpoint").trim(), model: api.settings.get("model").trim(), apiKey: api.settings.get("apiKey") });
  // Every call (chat, tool mode, the settings test) goes through the same URL, auth header and validation.
  // The API key is read from the current form value and never written to an error message or a log.
  const send = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const { endpoint, apiKey } = settings();
    if (!endpoint) throw new Error("请先在表单中填写完整的 Chat Completions URL。");
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("API endpoint 不是有效 URL。"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("远程 API 必须使用 HTTPS。");
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Network failures are reported by cause, not by dumping the request (which carries the key).
      throw new Error("无法连接 API：" + (error instanceof Error ? error.message : String(error)));
    }
    if (!response.ok) throw new Error(`AI API 请求失败：HTTP ${response.status}`);
    let result: unknown;
    try { result = await response.json(); } catch { throw new Error("API 返回的不是有效 JSON。"); }
    const message = (result as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] } | null)?.choices?.[0]?.message;
    if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) throw new Error("API 响应缺少 message.content 或 tool_calls");
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || !message.tool_calls.every((call: unknown) => {
      const c = call as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
      return c && typeof c.id === "string" && c.type === "function" && typeof c.function?.name === "string" && typeof c.function.arguments === "string";
    }))) throw new Error("API 返回了无效的工具调用");
    return { result: result as { model?: unknown }, message };
  };
  const chat = async (messages: AIMessage[], tools: CapabilityMap["tools"][], signal?: AbortSignal): Promise<AIMessage> => {
    const { model } = settings();
    if (!model) throw new Error("请先在表单中填写模型名称。");
    const { message } = await send({ model, messages, stream: false, ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: { name: tool.id, description: tool.description, parameters: tool.parameters } })) } : {}) }, signal);
    return { role: "assistant", content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) } as AIMessage;
  };
  return {
    id: "openai-compatible", name: "OpenAI Compatible API", chat,
    complete: async (messages: AIMessage[], signal?: AbortSignal) => {
      const reply = await chat(messages, [], signal);
      if (typeof reply.content !== "string") throw new Error("问答模式未返回文本");
      return reply.content;
    },
    /**
     * A single minimal Chat Completions request with the current form values and no project content.
     * Success is only reported after a parsed assistant message; the caller supplies cancellation.
     */
    test: async (signal?: AbortSignal): Promise<ProviderTestResult> => {
      const { model } = settings();
      if (!model) throw new Error("请先在表单中填写模型名称。");
      const started = Date.now();
      const { result, message } = await send({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false }, signal);
      const content = typeof message.content === "string" ? message.content.trim() : "";
      return {
        model: typeof result.model === "string" && result.model ? result.model : model,
        latencyMs: Date.now() - started,
        detail: content ? "收到有效回复（" + Array.from(content).length + " 字符）" : "收到有效的 Chat Completions 响应（无文本内容）",
      };
    },
  };
}
export const providerPlugin: StudioPlugin = {
  manifest: {
    id: "aether.ai.openai", name: "OpenAI Compatible API", version: "0.1.0", type: "ai-provider", entry: "builtin/provider.ts", enabled: true,
    settingsHelp: "地址和模型自动保存；API Key 只保存在本次会话内存，关闭或重启应用后需要重新填写。服务需允许浏览器 CORS。“测试连接”使用表单当前值发送一条不含工程内容的最小请求，可随时取消。发送问答会向此地址传送当前工程上下文。",
    presets: [{ id: "goat", label: "填入 GOAT 端点", description: "Command Code GOAT Provider API（OpenAI Chat Completions）。只预填地址和模型，不连接、不填写 Key；模型名可继续编辑。", settings: { endpoint: "https://api.commandcode.ai/provider/v1/chat/completions", model: "deepseek/deepseek-v4.1-flash" } }],
    settings: [{ key: "endpoint", label: "完整 Chat Completions URL", type: "url", placeholder: "https://api.example.com/v1/chat/completions" }, { key: "model", label: "模型名称", type: "text" }, { key: "apiKey", label: "API Key（仅本次会话）", type: "password", persist: false }],
    description: "配置 endpoint、model 和临时 API Key 后执行真实 HTTP 请求；提供问答和工程工具模式；文件修改先生成建议，由用户预览并应用。",
  },
  activate(api) {
    const provider = openAICompatibleProvider(api);
    api.register("providers", provider);
    api.register("agents", {
      id: "api-ask", name: "API 工程问答",
      run: async (project, messages, signal) => ({ text: await provider.complete([{ role: "system", content: "你是 Aether Studio 工程助手。仅提供建议；你没有执行工具，不能宣称修改、编译、测试、烧录过工程。当前工程：" + JSON.stringify(project) }, ...messages], signal) }),
    });
    api.register("agents", { id: "api-tools", name: "Project Tools", run: (project, messages, signal, onTool) => runToolAgent(api, project, messages, signal, onTool) });
  },
};
