import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Braces, ChevronDown, ChevronRight, FileCode2, FileJson, FileText, Folder, FolderOpen,
  FolderPlus, MoreHorizontal, Pencil, Plus, Trash2,
} from "lucide-react";
import { useDisk } from "../../store/disk";
import { useStudio } from "../../store/studio";
import { cn } from "../../lib/utils";
import { IconButton, Tip } from "../../components/ui";
import { useProjectFiles, parentOf } from "./projectFilesState";

interface Node { name: string; path: string; dir: boolean; children: Node[] }

function buildTree(files: string[], directories: string[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const index = new Map<string, Node>([["", root]]);
  const ensure = (path: string): Node => {
    if (index.has(path)) return index.get(path)!;
    const cut = path.lastIndexOf("/");
    const parent = ensure(cut < 0 ? "" : path.slice(0, cut));
    const node: Node = { name: path.slice(cut + 1), path, dir: true, children: [] };
    parent.children.push(node); index.set(path, node); return node;
  };
  for (const directory of directories) ensure(directory);
  for (const file of files) {
    const cut = file.lastIndexOf("/");
    const parent = ensure(cut < 0 ? "" : file.slice(0, cut));
    parent.children.push({ name: file.slice(cut + 1), path: file, dir: false, children: [] });
  }
  const sort = (nodes: Node[]) => { nodes.sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name, "zh") : a.dir ? -1 : 1); nodes.forEach((node) => sort(node.children)); };
  sort(root.children);
  return root.children;
}

const iconFor = (path: string) => {
  if (path === "circuit.json") return { Icon: Braces, color: "#8B6FC9" };
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(path)) return { Icon: FileCode2, color: "#3F7FCF" };
  if (/\.(py|js|ts|tsx|sh)$/.test(path)) return { Icon: FileCode2, color: "#3F9A75" };
  if (/\.(json|ini|board|aether)$/.test(path)) return { Icon: FileJson, color: "#B98A2C" };
  return { Icon: FileText, color: "#7C838C" };
};

export function ProjectExplorer() {
  const disk = useDisk();
  const files = useStudio((state) => state.files);
  const activeTab = useStudio((state) => state.activeTab);
  const openFile = useStudio((state) => state.openFile);
  const selected = useProjectFiles((state) => state.selected);
  const select = useProjectFiles((state) => state.select);
  const openDialog = useProjectFiles((state) => state.open);
  const [closed, setClosed] = useState<string[]>([]);
  const diskReady = !!disk.root;
  const tree = buildTree(Object.keys(files), disk.directories);
  const pendingChanges = disk.changed;
  // The virtual circuit view is host-owned: it can be opened but not renamed or trashed from the tree.
  const target = selected && selected !== "circuit.json" && (Object.hasOwn(files, selected) || disk.directories.includes(selected)) ? selected : null;
  const targetDir = target ? (disk.directories.includes(target) ? target : parentOf(target)) : "";
  const targetIsDir = !!target && disk.directories.includes(target);

  const createIn = (mode: "file" | "directory") => { if (diskReady) openDialog({ kind: "create", mode, parent: targetDir }); };

  return (
    <div>
      <div className="flex items-center gap-0.5 px-1 pb-1">
        <IconButton label="New file" className="h-[22px] w-[22px]" disabled={!diskReady} onClick={() => createIn("file")}><Plus size={12} /></IconButton>
        <IconButton label="New folder" className="h-[22px] w-[22px]" disabled={!diskReady} onClick={() => createIn("directory")}><FolderPlus size={12} /></IconButton>
        <IconButton label="Rename" className="h-[22px] w-[22px]" disabled={!diskReady || !target} onClick={() => target && openDialog({ kind: "rename", target, directory: targetIsDir })}><Pencil size={11.5} /></IconButton>
        <IconButton label="Move to Trash" className="h-[22px] w-[22px]" disabled={!diskReady || !target} onClick={() => target && openDialog({ kind: "delete", target, directory: targetIsDir })}><Trash2 size={11.5} /></IconButton>
        {pendingChanges && <span className="ml-auto text-[9px] font-medium text-[#A8741F]">磁盘变更</span>}
      </div>
      {!diskReady && <p className="px-2 py-1 text-[9px] leading-4 text-[#A3A8AF]">磁盘文件操作仅在桌面端打开的工程目录中可用。</p>}
      <div role="tree" aria-label="Project files">
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={1}
            closed={closed}
            onToggle={(path) => setClosed((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])}
            activeTab={activeTab}
            selected={selected}
            diskReady={diskReady}
            onOpen={(path) => { select(path); openFile(path); }}
            onSelect={(path) => select(path)}
            onAction={(kind) => {
              if (kind === "new-file") openDialog({ kind: "create", mode: "file", parent: node.dir ? node.path : parentOf(node.path) });
              else if (kind === "new-folder") openDialog({ kind: "create", mode: "directory", parent: node.dir ? node.path : parentOf(node.path) });
              else if (kind === "rename" && node.path !== "circuit.json") openDialog({ kind: "rename", target: node.path, directory: node.dir });
              else if (kind === "trash" && node.path !== "circuit.json") openDialog({ kind: "delete", target: node.path, directory: node.dir });
            }}
          />
        ))}
      </div>
      {diskReady && (
        <button className="mt-1 flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-1 text-left text-[9.5px] text-[#A8741F] hover:bg-[#FBF5E9]" onClick={() => openDialog({ kind: "changes" })}>
          <span className={cn("h-[4px] w-[4px] rounded-full", pendingChanges ? "bg-[#C08A2E]" : "bg-[#C7CBD1]")} />
          {pendingChanges ? "按文件处理磁盘变更…" : "检查磁盘变更…"}
        </button>
      )}
    </div>
  );
}

function TreeRow({ node, depth, closed, onToggle, activeTab, selected, diskReady, onOpen, onSelect, onAction }: {
  node: Node; depth: number; closed: string[]; onToggle: (path: string) => void; activeTab: string; selected: string | null;
  diskReady: boolean; onOpen: (path: string) => void; onSelect: (path: string) => void;
  onAction: (kind: "new-file" | "new-folder" | "rename" | "trash") => void;
}) {
  const expanded = !closed.includes(node.path);
  const isSelected = selected === node.path;
  const active = !node.dir && activeTab === node.path;
  const { Icon, color } = node.dir ? { Icon: expanded ? FolderOpen : Folder, color: "#8C939B" } : iconFor(node.path);
  const rowClass = cn("tree-row w-full cursor-default text-left group", active && "active", !active && isSelected && "bg-[#EEF2F7]");
  const body = (
    <>
      <span className="flex h-[14px] w-[14px] flex-none items-center justify-center">
        {node.dir ? (expanded ? <ChevronDown size={10} className="text-[#A0A5AC]" /> : <ChevronRight size={10} className="text-[#A0A5AC]" />) : <span className="w-[10px]" />}
      </span>
      <Icon size={12} strokeWidth={1.7} style={{ color: active ? "#0B5FBE" : color }} />
      <span className="truncate">{node.name}</span>
      {active && <span className="ml-auto h-[4px] w-[4px] flex-none rounded-full bg-[#007AFF]" />}
    </>
  );
  return (
    <div>
      <DropdownMenu.Root>
        <div
          className={rowClass}
          role="treeitem"
          aria-selected={active || isSelected}
          aria-label={node.path}
          tabIndex={0}
          style={{ paddingLeft: 4 + (depth - 1) * 14 }}
          onClick={() => { onSelect(node.path); if (node.dir) onToggle(node.path); else onOpen(node.path); }}
          onKeyDown={(event) => { if (event.key === "Enter") { if (node.dir) onToggle(node.path); else onOpen(node.path); } }}
        >
          {body}
          <DropdownMenu.Trigger asChild>
            <button
              aria-label={"Actions for " + node.path}
              className="ml-auto hidden h-[16px] w-[16px] flex-none items-center justify-center rounded-[3px] text-[#9AA0A8] hover:bg-[#E7EAEE] group-hover:flex"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal size={11} />
            </button>
          </DropdownMenu.Trigger>
        </div>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className="menu-content w-[196px]">
            {node.dir && <>
              <DropdownMenu.Item className="menu-item" disabled={!diskReady} onSelect={() => onAction("new-file")}>New file…</DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={!diskReady} onSelect={() => onAction("new-folder")}>New folder…</DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-sep" />
            </>}
            {!node.dir && <DropdownMenu.Item className="menu-item" onSelect={() => onOpen(node.path)}>Open</DropdownMenu.Item>}
            <DropdownMenu.Item className="menu-item" disabled={!diskReady || node.path === "circuit.json"} onSelect={() => onAction("rename")}>Rename…</DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" disabled={!diskReady || node.path === "circuit.json"} onSelect={() => onAction("trash")}>
              <Trash2 size={11} /> Move to Trash…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {node.dir && expanded && node.children.map((child) => (
        <TreeRow key={child.path} node={child} depth={depth + 1} closed={closed} onToggle={onToggle} activeTab={activeTab} selected={selected} diskReady={diskReady} onOpen={onOpen} onSelect={onSelect} onAction={onAction} />
      ))}
    </div>
  );
}
