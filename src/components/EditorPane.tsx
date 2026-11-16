import { useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  ChevronRight,
  FileCode2,
  GitCompareArrows,
  PanelRight,
  Sparkles,
  WrapText,
} from "lucide-react";
import { useStudio } from "../store/studio";
import { cn } from "../lib/utils";
import { Tip } from "./ui";

const languageFor = (file: string) => {
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".md")) return "markdown";
  return "plaintext";
};

export function EditorPane({ file }: { file: string }) {
  const content = useStudio((s) => s.files[file] ?? "");
  const updateFile = useStudio((s) => s.updateFile);
  const aiModified = useStudio((s) => s.aiModifiedFiles.includes(file));
  const dirty = useStudio((s) => s.dirty);
  const fontSize = useStudio((s) => s.settings.fontSize);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [wordWrap, setWordWrap] = useState(false);

  const beforeMount = (monaco: Parameters<OnMount>[1]) => {
    monaco.editor.defineTheme("aether-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "8A929B", fontStyle: "italic" },
        { token: "keyword", foreground: "9B3FA6" },
        { token: "keyword.control", foreground: "9B3FA6" },
        { token: "string", foreground: "B04B3E" },
        { token: "number", foreground: "4B5CB0" },
        { token: "type", foreground: "3D6D9C" },
        { token: "type.identifier", foreground: "3D6D9C" },
        { token: "identifier", foreground: "2B3036" },
        { token: "delimiter", foreground: "59616A" },
        { token: "operator", foreground: "4E5660" },
        { token: "function", foreground: "2C6E7E" },
        { token: "constant", foreground: "8F5B2F" },
      ],
      colors: {
        "editor.background": "#FFFFFF",
        "editor.foreground": "#2B3036",
        "editorLineNumber.foreground": "#B2B7BE",
        "editorLineNumber.activeForeground": "#616872",
        "editor.lineHighlightBackground": "#F6F8FB",
        "editor.lineHighlightBorder": "#00000000",
        "editor.selectionBackground": "#D9E9FF",
        "editor.inactiveSelectionBackground": "#EAF2FD",
        "editor.wordHighlightBackground": "#E8EEF6",
        "editor.findMatchBackground": "#FFE8A3",
        "editor.findMatchHighlightBackground": "#FFF3CC",
        "editorCursor.foreground": "#007AFF",
        "editorIndentGuide.background1": "#EEF1F4",
        "editorIndentGuide.activeBackground1": "#DCE1E7",
        "editorWhitespace.foreground": "#E3E6EA",
        "editorGutter.background": "#FFFFFF",
        "editorBracketMatch.background": "#EAF3FF",
        "editorBracketMatch.border": "#9CC7F7",
        "editorOverviewRuler.border": "#00000000",
        "editorError.foreground": "#D34A3D",
        "editorWarning.foreground": "#C08A2E",
        "editorInfo.foreground": "#007AFF",
        "editorHoverWidget.background": "#FFFFFF",
        "editorHoverWidget.border": "#E3E6EA",
        "editorSuggestWidget.background": "#FFFFFF",
        "editorSuggestWidget.border": "#E1E4E8",
        "editorSuggestWidget.selectedBackground": "#EAF3FF",
        "editorWidget.background": "#FFFFFF",
        "editorWidget.border": "#E1E4E8",
        "scrollbarSlider.background": "#1D1D1F22",
        "scrollbarSlider.hoverBackground": "#1D1D1F33",
        "scrollbarSlider.activeBackground": "#1D1D1F44",
        "editorGutter.modifiedBackground": "#007AFF",
      },
    });
  };

  const onMount: OnMount = (editor, monaco) => {
    editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => useStudio.getState().saveProject());
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <div className="flex h-[33px] flex-none items-center gap-1.5 border-b border-[#EFF1F4] px-3">
        <FileCode2 size={12} className="text-[#4C7EA8]" />
        <span className="text-[9.5px] text-[#9BA0A7]">{file.endsWith(".md") ? "docs" : file.endsWith(".json") ? "hardware" : "firmware"}</span>
        <ChevronRight size={9} className="text-[#C2C6CB]" />
        <span className="text-[10px] font-medium text-[#454B53]">{file}</span>
        {dirty && <span className="ml-0.5 h-[4px] w-[4px] rounded-full bg-[#C08A2E]" />}
        <span className="mx-1.5 h-[12px] w-px bg-[#ECEEF1]" />
        {aiModified && (
          <button className="flex h-[18px] items-center gap-1 rounded-[4px] bg-[#EEF5FF] px-1.5 text-[8.5px] font-medium text-[#2F6BAE] hover:bg-[#E4EFFF]" onClick={() => useStudio.getState().addToast({ title: "Aether changes", detail: aiModified ? "此文件有修改标记；尚未进行编译或硬件验证。" : "No agent edits", tone: "default" })}>
            <Sparkles size={9} fill="currentColor" strokeWidth={0} />
            Agent modified
          </button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Tip label={wordWrap ? "Disable word wrap" : "Enable word wrap"} side="bottom">
            <button className={cn("icon-btn h-[22px] w-[22px]", wordWrap && "is-active")} onClick={() => setWordWrap(!wordWrap)}>
              <WrapText size={12.5} />
            </button>
          </Tip>
          <Tip label="Review changes" side="bottom">
            <button className="icon-btn h-[22px] w-[22px]" onClick={() => useStudio.getState().addToast({ title: "Change review", detail: aiModified ? "AI patch is highlighted in the editor." : "No changes to review.", tone: "default" })}>
              <GitCompareArrows size={12.5} />
            </button>
          </Tip>
          <Tip label="Toggle split view" side="bottom">
            <button className="icon-btn h-[22px] w-[22px]" onClick={() => useStudio.getState().setSplitMode(!useStudio.getState().splitMode)}>
              <PanelRight size={12.5} />
            </button>
          </Tip>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <Editor
          key={file}
          path={useStudio.getState().activeProjectId + "/" + file}
          language={languageFor(file)}
          value={content}
          theme="aether-light"
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(value) => updateFile(file, value ?? "")}
          loading={<div className="flex h-full items-center justify-center text-[10px] text-[#9AA0A8]">Preparing editor…</div>}
          options={{
            automaticLayout: true,
            readOnly: file === "circuit.json",
            fontFamily: '"JetBrains Mono Variable", "SF Mono", monospace',
            fontSize,
            lineHeight: 21,
            fontLigatures: true,
            minimap: { enabled: false },
            renderLineHighlight: "all",
            lineNumbersMinChars: 3,
            glyphMargin: true,
            folding: true,
            foldingHighlight: false,
            padding: { top: 14, bottom: 30 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorSmoothCaretAnimation: "on",
            cursorBlinking: "smooth",
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true, indentation: true, highlightActiveIndentation: true },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            stickyScroll: { enabled: false },
            renderWhitespace: "selection",
            wordWrap: wordWrap ? "on" : "off",
            tabSize: 4,
            scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
            suggest: { showWords: true, preview: true },
            quickSuggestionsDelay: 120,
            contextmenu: true,
          }}
        />
      </div>
      <div className="flex h-[22px] flex-none items-center gap-3 border-t border-[#F0F2F4] px-3 text-[8.5px] text-[#A0A5AC]">
        <span>Ln {cursor.line}, Col {cursor.column}</span>
        <span>UTF-8</span>
        <span>Spaces: 4</span>
        <span className="ml-auto flex items-center gap-1"><span className="h-[4px] w-[4px] rounded-full bg-[#2B9661]" /> Text editor</span>
      </div>
    </div>
  );
}
