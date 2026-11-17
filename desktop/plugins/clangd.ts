import type { LanguageProvider } from "../language";
import type { ToolDefinition, ToolService } from "../tools";

// Public tool identity used by the C/C++ plugin UI. The host resolves it from settings → env → PATH.
export const clangdTool: ToolDefinition = {
  id: "clangd", name: "clangd", env: "AETHER_CLANGD_CLI", defaultExecutable: "clangd", versionArgs: ["--version"],
  description: "C/C++ 语言服务可执行文件。",
};

export function createClangdProvider(tool: ToolService): LanguageProvider {
  tool.define(clangdTool);
  return {
    id: "clangd", tool: "clangd", executable: () => tool.executable("clangd"),
    args: (root) => ["--background-index=false", "--clang-tidy=false", "--enable-config=false", "--log=error", "--compile-commands-dir=" + root],
  };
}
