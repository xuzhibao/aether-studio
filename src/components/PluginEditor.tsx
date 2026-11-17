import { useStudio } from "../store/studio";
import { usePlugins } from "../plugins/usePlugins";
export function PluginEditor({ file }: { file: string }) {
  const editorId = useStudio((s) => s.capabilities.editor);
  const editor = usePlugins().get("editors", editorId);
  if (!editor) return <div className="p-5 text-xs text-[#9A702C]">编辑器插件已停用，请在 Plugins 中启用。</div>;
  const Render = editor.render;
  return <Render file={file} />;
}
