import type { StudioPlugin } from "../api";
import { isDesktop } from "../../lib/desktop";
import { encodeProject, decodeProject } from "../../../shared/projectFormat";
export { encodeProject, decodeProject, validProjectPath } from "../../../shared/projectFormat";

const filters = [{ name: "Aether Studio Project", extensions: ["aether"] }];
async function saveFile(name: string, content: string): Promise<string | null> {
  if (isDesktop()) return window.aether!.files.export(name, content);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "浏览器下载已开始";
}
async function openFile(): Promise<string | null> {
  if (isDesktop()) return window.aether!.files.import();
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".aether,.json"; input.hidden = true;
    input.oncancel = () => { input.remove(); resolve(null); };
    input.onchange = () => {
      const file = input.files?.[0]; input.remove();
      if (!file) { resolve(null); return; }
      file.text().then(resolve, reject);
    };
    document.body.append(input); input.click();
  });
}
export const projectFilesPlugin: StudioPlugin = {
  manifest: { id: "aether.project-files", name: "工程文件", version: "0.1.0", type: "workspace", entry: "builtin/projectFiles.ts", enabled: true, description: "导入和导出包含电路、代码与能力绑定的 .aether 工程文件；桌面端支持真实工程目录及原生文件对话框。" },
  activate(api) {
    api.register("commands", { id: "project.folder.open", name: "Open project folder", shortcut: "mod+alt+o", run: () => api.host.openProjectFolder() });
    api.register("commands", { id: "project.folder.save", name: "Save project to folder", run: () => api.host.saveProjectFolder() });
    api.register("commands", { id: "project.folder.reload", name: "Reload folder (discard unsaved edits)", run: () => api.host.reloadProjectFolder() });
    api.register("menus", { id: "folder.open", name: "Open project folder", command: "project.folder.open", location: "project" });
    api.register("menus", { id: "folder.save", name: "Save project to folder", command: "project.folder.save", location: "project" });
    api.register("projectFormats", { id: "aether", name: "Aether Studio Project", encode: encodeProject, decode: decodeProject });
    api.register("commands", { id: "project.export", name: "Export project (.aether)", shortcut: "mod+shift+e", run: async () => {
      const context = api.project.get();
      const name = context.project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") + ".aether";
      const result = await saveFile(name, encodeProject(context));
      if (result) api.host.notify("工程已导出", result);
    } });
    api.register("commands", { id: "project.import", name: "Open project (.aether)", shortcut: "mod+shift+o", run: async () => {
      const content = await openFile();
      if (content === null) return;
      const project = decodeProject(content);
      api.host.importProject(project);
      api.host.notify("工程已导入", project.project.name + " · 已作为新的本地工程打开");
    } });
    api.register("menus", { id: "project.open.menu", name: "Open project (.aether)", command: "project.import", location: "project" });
    api.register("menus", { id: "project.export.menu", name: "Export project (.aether)", command: "project.export", location: "project" });
    api.register("menus", { id: "project.export.share", name: "Export project bundle", command: "project.export", location: "share" });
  },
};
