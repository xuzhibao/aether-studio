import type { EditProposal } from "../../types";
import type { StudioPlugin } from "../api";
import { validProjectPath } from "./projectFiles";
import { uid } from "../../lib/utils";

export const projectToolsPlugin: StudioPlugin = {
  manifest: { id: "aether.project-tools", name: "工程 Agent Tools", version: "0.1.0", type: "tool", entry: "builtin/projectTools.ts", enabled: true, description: "读取工程文件、检查电路数据和提出文件修改。修改必须经预览后手动应用；不执行终端、真实编译或硬件操作。" },
  activate(api) {
    api.register("tools", {
      id: "project_read_file", name: "读取工程文件", description: "Read the exact current contents of a project file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: (args, project) => {
        if (!args || typeof args !== "object" || typeof (args as {path?: unknown}).path !== "string") throw new Error("path 必须是文件名");
        const path = (args as {path: string}).path;
        if (!Object.hasOwn(project.files, path)) throw new Error("工程中没有文件：" + path);
        return { output: { path, content: project.files[path] } };
      },
    });
    api.register("tools", {
      id: "project_inspect_circuit", name: "查看工程电路", description: "Read component and wire definitions. This is not an electrical test or a hardware measurement.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: (_args, project) => ({ output: { components: project.components, wires: project.wires, note: "工程图数据；未进行电气校验或真实硬件测量。" } }),
    });
    api.register("tools", {
      id: "project_propose_files", name: "提出文件修改", description: "Propose complete contents for new or existing files. Creates a review proposal only; does not write files. Do not edit circuit.json (generated from the canvas).",
      parameters: { type: "object", properties: { summary: { type: "string" }, files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } }, required: ["summary", "files"], additionalProperties: false },
      execute: (args, project) => {
        const input = args as { summary?: unknown; files?: unknown };
        if (!input || typeof input.summary !== "string" || !Array.isArray(input.files) || !input.files.length) throw new Error("修改需要 summary 和非空 files 数组");
        const files = input.files as { path?: unknown; content?: unknown }[];
        if (!files.every((file) => file && typeof file.path === "string" && validProjectPath(file.path) && file.path !== "circuit.json" && typeof file.content === "string")) throw new Error("文件路径或内容无效；不能修改生成的 circuit.json");
        if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("同一批修改不能重复文件路径");
        const changes = (files as {path: string; content: string}[]).map(({ path, content }) => ({ path, before: Object.hasOwn(project.files, path) ? project.files[path] : null, after: content }));
        const proposal: EditProposal = { id: uid("proposal"), projectId: project.project.id, summary: input.summary, changes, status: "pending" };
        return { output: { status: "pending_review", files: changes.map((c) => c.path), message: "仅生成修改建议，尚未写入文件。用户需预览并手动应用。" }, proposal };
      },
    });
  },
};
