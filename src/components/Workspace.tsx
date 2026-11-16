import { usePlugins } from "../plugins/usePlugins";
import { useCallback, useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { CircuitCanvas } from "./circuit/CircuitCanvas";
import { Dock } from "./Dock";
import { PluginEditor as EditorPane } from "./PluginEditor";
import { SerialWorkspace } from "./SerialWorkspace";
import { TabBar } from "./TabBar";
import { clamp } from "../lib/utils";

function SplitDivider({ percent, onChange }: { percent: number; onChange: (p: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const rect = ref.current?.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const move = (e: PointerEvent) => onChange(clamp(((e.clientX - rect.left) / rect.width) * 100, 36, 72));
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.style.cursor = "col-resize";
    },
    [onChange],
  );
  return (
    <div
      ref={ref}
      onPointerDown={startDrag}
      className="group relative z-20 -mx-[2px] w-[5px] flex-none cursor-col-resize"
      aria-orientation="vertical"
      role="separator"
    >
      <span className="absolute inset-y-0 left-[2px] w-px bg-[#E5E8EC] transition-colors group-hover:bg-[#7FB9F5]" />
      <span className="absolute left-1/2 top-1/2 h-7 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-colors group-hover:bg-[#B7D6F8]" />
    </div>
  );
}

export function Workspace() {
  const activeTab = useStudio((s) => s.activeTab);
  const splitMode = useStudio((s) => s.splitMode);
  const plugins = usePlugins();
  const panel = plugins.all("panels").find((p) => activeTab === "panel:" + p.id);
  const Panel = panel?.render;
  const leftWidth = useStudio((s) => s.splitRatio);
  const setLeftWidth = useStudio((s) => s.setSplitRatio);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TabBar />
      <div className="relative flex min-h-0 flex-1">
        {Panel ? <Panel /> : activeTab.startsWith("panel:") ? <div className="p-5 text-xs text-[#9A702C]">此面板的插件已停用。</div> : activeTab === "circuit" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0" style={{ width: splitMode ? leftWidth + "%" : "100%" }}>
                <CircuitCanvas />
              </div>
              {splitMode && (
                <>
                  <SplitDivider percent={leftWidth} onChange={setLeftWidth} />
                  <div className="min-w-0 flex-1">
                    <EditorPane file="main.py" />
                  </div>
                </>
              )}
            </div>
            <Dock />
          </div>
        ) : activeTab === "serial" ? (
          <SerialWorkspace />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <EditorPane file={activeTab} />
            </div>
            <Dock />
          </div>
        )}
      </div>
    </div>
  );
}
