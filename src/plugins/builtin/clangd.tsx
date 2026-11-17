import { lazy, Suspense } from "react";
import type { StudioPlugin } from "../api";
const LazyPanel = lazy(() => import("./LanguagePanel"));
function LanguagePanel() { return <Suspense fallback={<div className="p-5 text-xs">Loading language service…</div>}><LazyPanel /></Suspense>; }
export const clangdPlugin: StudioPlugin = (() => {
  let active = false;
  let client: Promise<ReturnType<typeof import("../../language/clangdClient").createLanguageClient>> | undefined;
  const load = () => client ??= import("../../language/clangdClient").then((module) => module.createLanguageClient());
  return {
    manifest: { id: "aether.language.clangd", name: "C/C++ · clangd", version: "0.1.0", type: "language", entry: "builtin/clangd.tsx", enabled: true, description: "调用本机 clangd：未保存代码诊断、补全、悬停与工程内定义跳转。需磁盘工程，编译数据库由 PlatformIO 工具链生成。", dependencies: ["aether.editor.monaco"],
      settings: [{ key: "clangd.cli", label: "clangd 可执行文件", type: "tool-path", tool: "clangd", placeholder: "例如 C:/Program Files/LLVM/bin/clangd.exe 或 /usr/bin/clangd" }],
      settingsHelp: "保存后如果 clangd 正在运行，会自动重启语言服务并使用新路径，已打开的 C/C++ 文档会重新载入；启动失败时在 C/C++ Language 面板显示实际错误。留空时使用环境变量 AETHER_CLANGD_CLI，其次查找 PATH 中的 clangd。" },
    activate(api) {
      active = true; client = undefined; void load();
      api.register("languages", { id: "clangd", name: "C/C++ · clangd", languageIds: ["c", "cpp"], diagnosticsPanel: "language.problems", start: async (root) => { await (await load()).start(root); }, stop: async () => { await (await load()).stop(); }, attach: (attachment) => {
        let attached = true; let dispose: (() => void) | undefined;
        void load().then((value) => { if (attached && active) dispose = value.attach(attachment); });
        return () => { attached = false; dispose?.(); };
      } });
      api.register("panels", { id: "language.problems", name: "C/C++ Language", render: LanguagePanel });
    },
    deactivate() { active = false; const old = client; client = undefined; void old?.then((value) => value.dispose()); },
  };
})();
