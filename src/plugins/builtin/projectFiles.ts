import type { StudioPlugin } from "../api";
import { isDesktop } from "../../lib/desktop";
import { encodeProject, decodeProject } from "../../../shared/projectFormat";
import { useDisk } from "../../store/disk";
import { ProjectExplorer } from "./ProjectExplorer";
import { ProjectFilesDialogs } from "./ProjectFilesDialogs";
import { openChanges, parentOf, requireDisk, useProjectFiles } from "./projectFilesState";
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
  manifest: { id: "aether.project-files", name: "工程文件", version: "0.1.0", type: "workspace", entry: "builtin/projectFiles.ts", enabled: true, description: "导入和导出 .aether 工程文件；桌面端工程目录支持文件与目录的新建、重命名、移入系统回收站，以及按文件处理磁盘与缓冲区差异。" },
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
    api.register("explorers", { id: "project.files.tree", name: "Project files", render: ProjectExplorer });
    api.register("dialogs", { id: "project.files.dialogs", name: "Project file dialogs", render: ProjectFilesDialogs });
    const parentForCreate = () => {
      const selected = useProjectFiles.getState().selected;
      if (!selected) return "";
      return useDisk.getState().directories.includes(selected) ? selected : parentOf(selected);
    };
    const selectedEntry = () => {
      const selected = useProjectFiles.getState().selected;
      if (!selected) throw new Error("请先在文件树中选择文件或目录");
      return { target: selected, directory: useDisk.getState().directories.includes(selected) };
    };
    api.register("commands", { id: "project.files.new-file", name: "New file in project folder", run: () => { requireDisk(); useProjectFiles.getState().open({ kind: "create", mode: "file", parent: parentForCreate() }); } });
    api.register("commands", { id: "project.files.new-folder", name: "New folder in project folder", run: () => { requireDisk(); useProjectFiles.getState().open({ kind: "create", mode: "directory", parent: parentForCreate() }); } });
    api.register("commands", { id: "project.files.rename", name: "Rename project file or folder", run: () => { requireDisk(); const entry = selectedEntry(); useProjectFiles.getState().open({ kind: "rename", ...entry }); } });
    api.register("commands", { id: "project.files.delete", name: "Move project file or folder to Trash", run: () => { requireDisk(); const entry = selectedEntry(); useProjectFiles.getState().open({ kind: "delete", ...entry }); } });
    api.register("commands", { id: "project.files.changes", name: "Review per-file disk changes", run: () => { requireDisk(); return openChanges(); } });
    api.register("menus", { id: "project.files.menu.new-file", name: "New file…", command: "project.files.new-file", location: "project" });
    api.register("menus", { id: "project.files.menu.new-folder", name: "New folder…", command: "project.files.new-folder", location: "project" });
    api.register("menus", { id: "project.files.menu.changes", name: "Review disk changes…", command: "project.files.changes", location: "project" });
  },
};
