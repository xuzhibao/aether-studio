import { useEffect, useState } from "react";
import { usePlugins } from "../plugins/usePlugins";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowUpToLine,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  Cloud,
  Command,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FolderKanban,
  Hammer,
  Link2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  Search,
  Settings2,
  Share2,
  Sparkles,
  Terminal,
  UserRound,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { windowAction } from "../lib/desktop";
import { IconButton, Kbd, Logo, Tip } from "./ui";

function SavedState({ dirty }: { dirty: boolean }) {
  return (
    <span className="flex items-center gap-1 text-[9.5px] font-medium text-[#969ba3]">
      {dirty ? (
        <>
          <span className="h-[4px] w-[4px] rounded-full bg-[#C08A2E]" />
          Unsaved changes
        </>
      ) : (
        <>
          <Check size={9.5} strokeWidth={2.6} className="text-[#7A8088]" />
          Saved to workspace
        </>
      )}
    </span>
  );
}

export function TopBar() {
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const projects = useStudio((s) => s.projects);
  const dirty = useStudio((s) => s.dirty);
  const settings = useStudio((s) => s.settings);
  const [fontInput, setFontInput] = useState(String(settings.fontSize));
  useEffect(() => setFontInput(String(settings.fontSize)), [settings.fontSize]);
  const runState = useStudio((s) => s.runState);
  const agentCollapsed = useStudio((s) => s.agentCollapsed);
  const project = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const { runSimulation, pauseSimulation, resetSimulation, build, setDialog, setCommandOpen, setAgentCollapsed, saveProject, switchProject, setActiveNav, addToast } = useStudio();

  const registry = usePlugins();
  const traffic = async (action: "close" | "minimize" | "maximize") => {
    const handled = await windowAction(action);
    if (!handled) addToast({ title: "Desktop window", detail: "Window controls are enabled in the Electron desktop app.", tone: "default" });
  };

  return (
    <header
      data-desktop-drag-region
      className="relative z-30 flex h-[54px] flex-none items-center gap-2 bg-[#FCFCFD]/95 px-3 hairline-b"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="traffic-group flex items-center gap-[7px] pl-1 pr-1">
          <button className="traffic close" aria-label="Close window" title="Close" onClick={() => void traffic("close")} />
          <button className="traffic min" aria-label="Minimize window" title="Minimize" onClick={() => void traffic("minimize")} />
          <button className="traffic max" aria-label="Zoom window" title="Zoom" onClick={() => void traffic("maximize")} />
        </div>
        <div className="h-[22px] w-px bg-[#E6E8EB]" />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="btn px-2 py-1 text-[10px]">Plugins</DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="menu-content" sideOffset={8}>
            <DropdownMenu.Item className="menu-item" onSelect={() => setDialog("plugins")}>管理插件</DropdownMenu.Item>
            {registry.all("menus").filter((menu) => !menu.location || menu.location === "plugins").map((menu) => <DropdownMenu.Item key={menu.id} className="menu-item" onSelect={() => { void Promise.resolve().then(() => registry.require("commands", menu.command).run()).catch((error) => addToast({ title: "插件命令失败", detail: String(error), tone: "warn" })); }}>{menu.name}</DropdownMenu.Item>)}
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="group -ml-1 flex min-w-0 items-center gap-2.5 rounded-[7px] px-1.5 py-1 text-left outline-none hover:bg-[#F3F4F6] data-[state=open]:bg-[#F3F4F6]">
              <Logo size={25} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="max-w-[186px] truncate text-[12.5px] font-[560] tracking-[-0.012em] text-[#1D1D1F]">
                    {project.name}
                  </span>
                  <ChevronDown size={11} className="text-[#A0A4AA] transition-transform group-data-[state=open]:rotate-180" />
                </div>
                <div className="mt-[2px] flex items-center gap-2">
                  <SavedState dirty={dirty} />
                  <span className="text-[9px] text-[#B0B4BA]">/</span>
                  <span className="text-[9.5px] text-[#A0A5AC]">Aether Studio</span>
                </div>
              </div>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={8} className="menu-content w-[286px]">
              <div className="px-2 pb-1 pt-1.5">
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[#9A9FA7]">Recent projects</div>
              </div>
              {projects.map((p) => (
                <DropdownMenu.Item key={p.id} className="menu-item" onSelect={() => switchProject(p.id)}>
                  <FolderKanban size={13} className="text-[#7C828B]" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.id === activeProjectId ? (
                    <Check size={12} className="text-[#007AFF]" />
                  ) : (
                    <span className="menu-meta">{p.updated.replace("Edited ", "")}</span>
                  )}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.Item className="menu-item" onSelect={() => setDialog("new-project")}>
                <Plus size={13} /> New Project
                <span className="menu-meta">⇧⌘N</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => setDialog("overview")}>
                <Box size={13} /> Project Overview
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => addToast({ title: "Project settings", detail: "Workspace configuration is up to date.", tone: "default" })}>
                <Settings2 size={13} /> Project Settings
              </DropdownMenu.Item>
              {registry.all("menus").filter((menu) => menu.location === "project").map((menu) => <DropdownMenu.Item key={menu.id} className="menu-item" onSelect={() => { void Promise.resolve().then(() => registry.require("commands", menu.command).run()).catch((error) => addToast({ title: "插件命令失败", detail: String(error), tone: "warn" })); }}>{menu.name}</DropdownMenu.Item>)}
              <DropdownMenu.Separator className="menu-sep" />
              <DropdownMenu.Item className="menu-item" onSelect={saveProject}>
                <Cloud size={13} /> Save Snapshot
                <span className="menu-meta">⌘S</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <div className="toolbar-center absolute left-1/2 top-0 z-10 flex h-full -translate-x-1/2 items-center justify-center gap-1.5 px-1">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn h-[27px] gap-1.5 rounded-[6.5px] pl-2 pr-1.5 text-[10.5px] font-medium text-[#3B3F45]">
              <Cpu size={13} strokeWidth={1.7} className="text-[#70767E]" />
              <span className="hidden min-[1360px]:inline">{project.board}</span>
              <span className="min-[1360px]:hidden">{project.board}</span>
              <span className="mx-0.5 h-3 w-px bg-[#ECEEF1]" />
              <span className="h-[5px] w-[5px] rounded-full bg-[#2B9661]" />
              <ChevronDown size={10} className="text-[#9AA0A8]" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
          <DropdownMenu.Content align="center" sideOffset={8} className="menu-content w-[286px]">
            <div className="menu-label">Target board</div>
            {registry.all("boards").map((definition) => <DropdownMenu.Item key={definition.id} className="menu-item" onSelect={() => setDialog("plugins")}>
              <Cpu size={13} className="text-[#007AFF]" /><div className="flex flex-col"><span>{definition.name}</span><span className="text-[9px] text-[#A0A5AC]">{definition.description}</span></div>
            </DropdownMenu.Item>)}
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item className="menu-item" onSelect={() => setDialog("plugins")}>
              <Terminal size={13} /> Manage board packages…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

        <div className="mx-0.5 h-[18px] w-px bg-[#E8EAED]" />

        <button
          onClick={runSimulation}
          className={cn("btn btn-primary h-[27px] gap-1.5 px-2.5 text-[11px]", runState === "running" && "shadow-[inset_0_0.5px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,84,178,0.18)]")}
        >
          <Play size={11} fill="currentColor" strokeWidth={0} className="translate-y-[0.2px]" />
          Run Simulation
        </button>
        <IconButton label="Pause simulation" onClick={pauseSimulation} disabled={runState !== "running"} className="disabled:opacity-35">
          <Pause size={13} fill="currentColor" strokeWidth={0} />
        </IconButton>
        <IconButton label="Reset simulation" onClick={resetSimulation}>
          <RotateCcw size={13.5} strokeWidth={1.8} />
        </IconButton>

        <div className="mx-0.5 h-[18px] w-px bg-[#E8EAED]" />

        <button onClick={build} className="btn btn-ghost h-[27px] gap-1.5 px-2 text-[10.5px] text-[#4D545C]">
          <Hammer size={12.5} strokeWidth={1.75} className="text-[#70767E]" />
          {registry.get("toolchains", useStudio.getState().capabilities.toolchain)?.build ? "Build" : "Check Files"}
        </button>
        <button onClick={() => setDialog("deploy")} className="btn h-[27px] gap-1.5 border-[#D9DDE3] px-2.5 text-[10.5px] font-[520] text-[#2F3339]">
          <ArrowUpToLine size={12.5} strokeWidth={1.9} className="text-[#007AFF]" />
          Deploy to Device
        </button>
      </div>

        <div className="ml-auto flex flex-none items-center gap-1.5">
          <button
            onClick={() => setCommandOpen(true)}
          className="group flex h-[27px] w-[164px] flex-none items-center gap-1.5 whitespace-nowrap rounded-[6.5px] border border-[#E4E7EB] bg-white/70 px-2 text-left text-[10.5px] text-[#8A8F97] transition-colors hover:border-[#D8DCE1] hover:bg-white max-[1460px]:w-[30px] max-[1460px]:justify-center max-[1460px]:px-0"
          aria-label="Command search"
          title="Command search · ⌘K"
        >
          <Search size={12.5} strokeWidth={1.9} />
          <span className="max-[1460px]:hidden">Command search</span>
          <span className="ml-auto max-[1460px]:hidden"><Kbd>⌘K</Kbd></span>
        </button>

        <button
          onClick={() => setAgentCollapsed(!agentCollapsed)}
          className={cn(
            "flex h-[27px] items-center gap-1.5 rounded-[6.5px] border px-2 text-[10.5px] font-[520] transition-all",
            !agentCollapsed
              ? "border-[#CFE2FA] bg-[#EDF5FF] text-[#0068D6]"
              : "border-[#E4E7EB] bg-white text-[#6F747C] hover:bg-[#F8F9FA]",
          )}
        >
          <Sparkles size={12} strokeWidth={1.8} />
          Agent Mode
        </button>

        <div className="mx-0.5 h-[18px] w-px bg-[#E8EAED]" />

        <Popover.Root>
          <Popover.Trigger asChild>
            <button className="icon-btn" aria-label="Share project">
              <Share2 size={14} strokeWidth={1.8} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={9} className="popover w-[286px] p-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[#EDF5FF] text-[#007AFF]"><Link2 size={14} /></div>
                <div>
                  <div className="text-[11.5px] font-semibold">Share workspace</div>
                  <div className="text-[10px] text-[#8A8F97]">当前工程仅保存在本机。</div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 rounded-[7px] border border-[#E5E8EC] bg-[#FAFBFC] p-1 pl-2.5">
                <span className="truncate text-[10px] text-[#697079]">分享尚未实现</span>
                <button className="ml-auto flex h-[22px] items-center gap-1 rounded-[5px] bg-white px-2 text-[9.5px] font-medium shadow-sm ring-1 ring-[#E1E4E8]" onClick={() => addToast({ title: "尚未实现", detail: "分享链接尚未实现。", tone: "default" })}>
                  <Copy size={10} /> Copy
                </button>
              </div>
              {registry.all("menus").filter((menu) => menu.location === "share").map((menu) => <button key={menu.id} className="menu-item mt-1.5 h-[27px] w-full px-1.5" onClick={() => { void Promise.resolve().then(() => registry.require("commands", menu.command).run()).catch((error) => addToast({ title: "插件命令失败", detail: String(error), tone: "warn" })); }}><Download size={12} />{menu.name}</button>)}
              <button className="menu-item h-[27px] w-full px-1.5" onClick={() => addToast({ title: "尚未实现", detail: "在线工程预览尚未实现。", tone: "default" })}>
                <ExternalLink size={12} /> Open read-only preview
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <Popover.Root>
          <Popover.Trigger asChild>
            <button className="icon-btn" aria-label="Workspace settings">
              <Settings2 size={14} strokeWidth={1.75} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={9} className="popover w-[300px] p-3">
              <div className="flex items-center justify-between pb-2">
                <div className="text-[11.5px] font-semibold">Workspace settings</div>
                <span className="text-[9px] text-[#9CA1A8]">Aether 0.1.0</span>
              </div>
              <label className="mt-2 flex items-center justify-between text-[10.5px] text-[#5C626A]">Editor font size
                <input aria-label="Editor font size" type="number" min={10} max={22} step={0.5} value={fontInput} className="input w-[70px] text-[10px]" onChange={(e) => setFontInput(e.target.value)} onBlur={() => { const value = Number(fontInput); if (!fontInput || !Number.isFinite(value) || value < 10 || value > 22) { setFontInput(String(settings.fontSize)); addToast({ title: "字号范围为 10–22", tone: "warn" }); return; } useStudio.getState().updateSettings({ fontSize: value }); }} />
              </label>
              <label className="mt-3 flex items-center justify-between text-[10.5px] text-[#5C626A]">Reduce motion
                <input aria-label="Reduce motion" type="checkbox" checked={settings.reducedMotion} onChange={(e) => useStudio.getState().updateSettings({ reducedMotion: e.target.checked })} />
              </label>
              <div className="mt-3 flex gap-2"><button className="btn px-2 py-1 text-[10px]" onClick={() => useStudio.getState().saveLayout()}>Save layout</button><button className="btn px-2 py-1 text-[10px]" onClick={() => useStudio.getState().resetLayout()}>Reset layout</button></div>
              <div className="my-2 h-px bg-[#ECEEF1]" />
              <button className="menu-item h-[27px] w-full" onClick={() => addToast({ title: "Documentation", detail: "请查看仓库 README.md。", tone: "default" })}>
                <CircleHelp size={12} /> Documentation
                <span className="menu-meta">⌘?</span>
              </button>
              <button className="menu-item h-[27px] w-full" onClick={() => addToast({ title: "Keyboard shortcuts", detail: "Command palette lists every shortcut.", tone: "default" })}>
                <Command size={12} /> Keyboard shortcuts
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="ml-0.5 flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[#2E3238] text-[9px] font-semibold tracking-[0.02em] text-white/90 ring-2 ring-white outline-none">
              AL
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} className="menu-content w-[218px]">
            <div className="flex items-center gap-2 px-2 py-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2E3238] text-[10px] font-semibold text-white">AL</div>
              <div>
                <div className="text-[11.5px] font-semibold">本地工作区</div>
                <div className="text-[9.5px] text-[#9AA0A8]">未登录云端账号</div>
              </div>
            </div>
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item className="menu-item" onSelect={() => addToast({ title: "Account", detail: "账号系统尚未实现。", tone: "default" })}>
              <UserRound size={12} /> Account
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => addToast({ title: "尚未实现", detail: "云端同步尚未接入。", tone: "default" })}>
              <Cloud size={12} /> Sync now
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item className="menu-item" onSelect={() => setActiveNav("overview")}>
              <Box size={12} /> Project overview
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      </div>
    </header>
  );
}
