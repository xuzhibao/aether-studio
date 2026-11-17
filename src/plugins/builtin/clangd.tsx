import { lazy } from "react";
import type { StudioPlugin } from "../api";
const LanguagePanel = lazy(() => import("./LanguagePanel"));
export const clangdPlugin: StudioPlugin = (() => {
  let active = false;
  let client: Promise<ReturnType<typeof import("../../language/clangdClient").createLanguageClient>> | undefined;
  const load = () => client ??= import("../../language/clangdClient").then((module) => module.createLanguageClient());
  return {
    manifest: { id: "aether.language.clangd", name: "C/C++ · clangd", version: "0.1.0", type: "language", entry: "builtin/clangd.tsx", enabled: true, description: "调用本机 clangd：未保存代码诊断、补全、悬停与工程内定义跳转。需磁盘工程，编译数据库由 PlatformIO 工具链生成。", dependencies: ["aether.editor.monaco"] },
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
