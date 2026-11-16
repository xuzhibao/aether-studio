import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  CircuitBoard,
  Columns2,
  FileCode2,
  FileJson,
  FileText,
  MoreHorizontal,
  PanelBottom,
  PanelBottomClose,
  X,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { Tip } from "./ui";

const iconFor = (tab: string) => {
  if (tab === "circuit") return CircuitBoard;
  if (tab === "serial") return Activity;
  if (tab === "main.py" || tab === "sensors.py" || tab.endsWith(".py")) return FileCode2;
  if (tab.endsWith(".json") || tab.endsWith(".board")) return FileJson;
  return FileText;
};

const labelFor = (tab: string) => (tab === "circuit" ? "Circuit" : tab === "serial" ? "Serial Monitor" : tab.split("/").pop());

export function TabBar() {
  const { openTabs, activeTab, setTab, closeTab, aiModifiedFiles, splitMode, setSplitMode, dockOpen, setDockOpen, addToast, saveProject } = useStudio();
  const pinned = new Set(["circuit", "serial"]);

  return (
    <div className="flex h-[40px] flex-none items-center gap-1 border-b border-[#E9EBEE] bg-[#FBFBFC] px-2">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
        {openTabs.map((tab) => {
          const Icon = iconFor(tab);
          const modified = aiModifiedFiles.includes(tab);
          const active = activeTab === tab;
          return (
            <div
              key={tab}
              className={cn("workspace-tab group", active && "active")}
              onClick={() => setTab(tab)}
              role="tab"
              aria-label={labelFor(tab)}
              aria-selected={active}
            >
              <Icon size={11.5} strokeWidth={1.8} className={active ? "text-[#4D5B6C]" : "text-[#9AA0A8]"} />
              <span className="max-w-[150px] truncate">{labelFor(tab)}</span>
              {modified && <span className="h-[4px] w-[4px] rounded-full bg-[#007AFF]" />}
              {!pinned.has(tab) && (
                <button
                  className={cn(
                    "ml-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-[3px] text-[#9AA0A8] hover:bg-[#E7EAEE] hover:text-[#4A5059]",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab);
                  }}
                  aria-label={"Close " + tab}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-none items-center gap-0.5 pl-1">
        <Tip label={splitMode ? "Close split editor" : "Split with editor"}>
          <button
            className={cn("icon-btn h-[25px] w-[25px]", splitMode && "is-active")}
            onClick={() => {
              if (!splitMode) {
                setTab("circuit");
                setSplitMode(true);
              } else setSplitMode(false);
            }}
          >
            <Columns2 size={13.5} />
          </button>
        </Tip>
        <Tip label={dockOpen ? "Hide debug panel" : "Show debug panel"}>
          <button className={cn("icon-btn h-[25px] w-[25px]", dockOpen && "is-active")} onClick={() => setDockOpen(!dockOpen)}>
            {dockOpen ? <PanelBottomClose size={13.5} /> : <PanelBottom size={13.5} />}
          </button>
        </Tip>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="icon-btn h-[25px] w-[25px]">
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="menu-content w-[216px]">
            <DropdownMenu.Item className="menu-item" onSelect={saveProject}>
              Save workspace <span className="menu-meta">⌘S</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => setSplitMode(!splitMode)}>
              {splitMode ? "Hide split editor" : "Split circuit with editor"}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.getState().resetView()}>
              Fit canvas to view
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item className="menu-item" onSelect={() => useStudio.getState().saveLayout()}>
              Save panel layout
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => addToast({ title: "Tabs", detail: "All project files are available in the explorer.", tone: "default" })}>
              Open recent…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <div className="ml-0.5 hidden items-center gap-1 pl-1 text-[8.5px] text-[#A3A8AF] min-[1420px]:flex">
        <span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" />
        Agent linked
      </div>
      </div>
    </div>
  );
}
