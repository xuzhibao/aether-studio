import type { PluginAPI, StudioPlugin } from "../api";
export function openAICompatibleProvider(api: PluginAPI) {
  return {
    id: "openai-compatible", name: "OpenAI Compatible API",
    async complete(messages: Parameters<import("../api").CapabilityMap["providers"]["complete"]>[0], signal?: AbortSignal) {
      const endpoint = api.settings.get("endpoint");
      const model = api.settings.get("model");
      const apiKey = api.settings.get("apiKey");
      if (!endpoint || !model) throw new Error("请在 Plugins 配置 API endpoint 和 model。");
      const url = new URL(endpoint);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("远程 API 必须使用 HTTPS。");
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model, messages, stream: false }), signal });
      if (!response.ok) throw new Error(`AI API 请求失败：HTTP ${response.status}`);
      const result = await response.json();
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("API 响应缺少 choices[0].message.content");
      return content;
    },
  };
}
export const providerPlugin: StudioPlugin = {
  manifest: { id: "aether.ai.openai", name: "OpenAI Compatible API", version: "0.1.0", type: "ai-provider", entry: "builtin/provider.ts", enabled: true, settingsHelp: "地址和模型自动保存；API Key 不写入持久存储。服务需允许浏览器 CORS。发送问答会向此地址传送当前工程上下文。", settings: [{ key: "endpoint", label: "完整 Chat Completions URL", type: "url", placeholder: "https://api.example.com/v1/chat/completions" }, { key: "model", label: "模型名称", type: "text" }, { key: "apiKey", label: "API Key（仅本次会话）", type: "password", persist: false }], description: "配置 endpoint、model 和临时 API Key 后执行真实 HTTP 请求；本轮仅提供问答，不自动修改或执行工程。" },
  activate(api) {
    const provider = openAICompatibleProvider(api);
    api.register("providers", provider);
    api.register("agents", {
      id: "api-ask", name: "API 工程问答",
      run: (project, messages, signal) => provider.complete([{ role: "system", content: "你是 Aether Studio 工程助手。仅提供建议；你没有执行工具，不能宣称修改、编译、测试、烧录过工程。当前工程：" + JSON.stringify(project) }, ...messages], signal),
    });
  },
};
