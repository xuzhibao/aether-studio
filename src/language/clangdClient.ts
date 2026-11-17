import type * as Monaco from "monaco-editor";
import type { CompletionItem, CompletionList, Hover, DefinitionTarget, Range, LanguageSnapshot } from "../../shared/language";
import type { EditorAttachment } from "../plugins/api";
import { useStudio } from "../store/studio";
import { useLanguage } from "../store/language";
import { useDisk } from "../store/disk";
import { isDesktop } from "../lib/desktop";
const markerOwner = "aether.clangd";
const range = (value: Range) => ({ startLineNumber: value.start.line + 1, startColumn: value.start.character + 1, endLineNumber: value.end.line + 1, endColumn: value.end.character + 1 });
interface LanguageBinding { root: string; file: string; model: Monaco.editor.ITextModel; sessionId: number | null; ready: Promise<LanguageSnapshot>; flush: () => Promise<void>; dispose: () => void }
const kinds = ["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"] as const;
export function createLanguageClient() {
  if (!isDesktop()) return { start: async (_root: string) => { throw new Error("语言服务需要 Electron 桌面端"); }, stop: async () => {}, restart: async () => { throw new Error("语言服务需要 Electron 桌面端"); }, attach: (_attachment: EditorAttachment) => () => {}, dispose: () => {} };
  const api = window.aether!.language;
  let latest: LanguageSnapshot | null = null;
  const starting = new Set<Promise<LanguageSnapshot>>();
  let active = true; let monaco: typeof Monaco | undefined;
  const bindings = new Map<string, LanguageBinding>();
  const providers: Monaco.IDisposable[] = [];
  const report = (error: unknown) => { if (active) useLanguage.setState({ error: String(error) }); };
  const clear = (root?: string) => { for (const [uri, binding] of bindings) if (!root || binding.root === root) { bindings.delete(uri); binding.dispose(); } };
  const apply = (snapshot: LanguageSnapshot) => {
    if (!active) return;
    latest = snapshot; useLanguage.setState({ snapshot, error: snapshot.error });
    if (snapshot.status === "ready") {
      // clangd was restarted after a saved tool path change; reopen the buffers this session lost.
      for (const binding of bindings.values()) {
        if (binding.root !== snapshot.root || binding.sessionId === null || binding.sessionId === snapshot.id || binding.model.isDisposed()) continue;
        binding.sessionId = snapshot.id;
        binding.ready = api.open(snapshot.id, binding.file, binding.model.getValue(), binding.model.getVersionId()).then(() => snapshot).catch((error) => { report(error); return snapshot; });
      }
    }
    if (snapshot.status === "stopped" || snapshot.status === "error") clear(snapshot.root);
    for (const binding of bindings.values()) {
      if (binding.root !== snapshot.root || binding.model.isDisposed()) continue;
      const document = snapshot.documents.find((item) => item.file === binding.file);
      const diagnostics = document?.version === binding.model.getVersionId() ? document.diagnostics : [];
      monaco!.editor.setModelMarkers(binding.model, markerOwner, diagnostics.map((item) => ({ ...range(item.range), message: item.message, source: item.source ?? "clangd", code: item.code === undefined ? undefined : String(item.code), severity: item.severity === 1 ? monaco!.MarkerSeverity.Error : item.severity === 2 ? monaco!.MarkerSeverity.Warning : item.severity === 4 ? monaco!.MarkerSeverity.Hint : monaco!.MarkerSeverity.Info })));
    }
  };
  const offStatus = api.onChanged(apply);
  void api.get().then((value) => { if (value) apply(value); }).catch(report);
  const offStore = useStudio.subscribe((state) => {
    for (const [uri, binding] of bindings) {
      if (!state.openTabs.includes(binding.file) || state.files[binding.file] === undefined) { bindings.delete(uri); binding.dispose(); }
      else if (binding.model.getValue() !== state.files[binding.file]) binding.model.setValue(state.files[binding.file]);
    }
  });
  const navigate = (file: string, target: Range) => {
    if (!Object.hasOwn(useStudio.getState().files, file)) return false;
    useLanguage.setState({ jump: { file, range: target } }); useStudio.getState().openFile(file); return true;
  };
  function install(monacoAPI: typeof Monaco) {
    monaco = monacoAPI;
    const request = async (model: Monaco.editor.ITextModel, position: Monaco.Position, method: "completion" | "hover" | "definition", token: Monaco.CancellationToken) => {
      const binding = bindings.get(model.uri.toString()); if (!binding || token.isCancellationRequested) return null;
      try {
        await binding.flush(); const session = await binding.ready; const version = model.getVersionId();
        const result = await api.request(session.id, binding.file, version, method, { line: position.lineNumber - 1, character: position.column - 1 });
        return token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version ? null : result;
      } catch (error) { report(error); return null; }
    };
    providers.push(monaco.languages.registerCompletionItemProvider(["c", "cpp"], {
      triggerCharacters: [".", ">", ":"],
      async provideCompletionItems(model, position, _context, token) {
        const result = await request(model, position, "completion", token) as CompletionItem[] | CompletionList | null;
        const items = Array.isArray(result) ? result : result?.items ?? [];
        const word = model.getWordUntilPosition(position);
        return { incomplete: !Array.isArray(result) && !!result?.isIncomplete, suggestions: items.map((item) => {
          const edit = item.textEdit; const name = kinds[(item.kind ?? 1) - 1] ?? "Text";
          return { label: item.label, kind: monacoAPI.languages.CompletionItemKind[name], detail: item.detail, documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value, filterText: item.filterText, sortText: item.sortText,
            insertText: edit?.newText ?? item.insertText ?? item.label, insertTextRules: item.insertTextFormat === 2 ? monacoAPI.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range: edit && "range" in edit ? range(edit.range) : { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: position.column },
            additionalTextEdits: item.additionalTextEdits?.map((item) => ({ range: range(item.range), text: item.newText })),
          };
        }) };
      },
    }));
    providers.push(monaco.languages.registerHoverProvider(["c", "cpp"], {
      async provideHover(model, position, token) {
        const result = await request(model, position, "hover", token) as Hover | null; if (!result) return null;
        const values = Array.isArray(result.contents) ? result.contents : [result.contents];
        return { range: result.range ? range(result.range) : undefined, contents: values.map((item) => ({ value: typeof item === "string" ? item : item.value, isTrusted: false, supportHtml: false })) };
      },
    }));
    providers.push(monaco.languages.registerDefinitionProvider(["c", "cpp"], {
      async provideDefinition(model, position, token) {
        const result = await request(model, position, "definition", token) as DefinitionTarget[] | null;
        return result?.filter((item) => Object.hasOwn(useStudio.getState().files, item.file)).map((item) => {
          const uri = monacoAPI.Uri.parse(item.uri);
          if (!monacoAPI.editor.getModel(uri)) monacoAPI.editor.createModel(useStudio.getState().files[item.file], /\.c$/.test(item.file) ? "c" : "cpp", uri);
          return { uri, range: range(item.range) };
        }) ?? [];
      },
    }));
    providers.push(monaco.editor.registerEditorOpener({ openCodeEditor: (_source, resource, selection) => {
      const binding = [...bindings.values()].find((item) => item.model.uri.toString() === resource.toString());
      const root = useLanguage.getState().snapshot?.root; if (!root) return false;
      const prefix = monacoAPI.Uri.file(root.replaceAll("\\", "/") + "/").toString();
      const file = binding?.file ?? (resource.toString().startsWith(prefix) ? decodeURIComponent(resource.toString().slice(prefix.length)) : "");
      const line = selection && "startLineNumber" in selection ? selection.startLineNumber : selection?.lineNumber ?? 1;
      const column = selection && "startColumn" in selection ? selection.startColumn : selection?.column ?? 1;
      return navigate(file, { start: { line: line - 1, character: column - 1 }, end: { line: line - 1, character: column - 1 } });
    } }));
  }
  // The process is pinned to the selected PlatformIO environment and the stored query-driver opt-in.
  const launch = () => ({ environment: useDisk.getState().environment || undefined, queryDriver: useLanguage.getState().queryDriver });
  const start = async (root: string) => {
    const pending = api.start("clangd", root, launch()); starting.add(pending);
    try {
      const session = await pending;
      if (!active) { await api.stop(session.id); throw new Error("语言插件已停用"); }
      return session;
    } finally { starting.delete(pending); }
  };
  // Switching environments must not keep the previous environment's flags or diagnostics alive.
  const offEnvironment = useDisk.subscribe((state, previous) => {
    if (state.environment === previous.environment) return;
    const snapshot = latest;
    if (!snapshot || snapshot.status === "stopped" || snapshot.status === "error") return;
    // A process that is still starting must not finish with the previous environment's flags.
    if (snapshot.environment === state.environment) return;
    void start(snapshot.root).catch(report);
  });
  return {
    start: async (root: string) => { await start(root); },
    stop: async () => { await Promise.allSettled(starting); if (latest) await api.stop(latest.id); },
    restart: async () => {
      if (!latest) throw new Error("语言服务尚未启动");
      const session = await api.restart(latest.id, launch());
      // The plugin may have been disabled while the restart was in flight.
      if (!active) await api.stop(session.id).catch(() => {});
    },
    attach(attachment: EditorAttachment) {
      if (!monaco) install(attachment.monaco);
      const { model, file, root } = attachment; const uri = model.uri.toString();
      if (bindings.has(uri)) return () => {};
      let live = true; let timer: ReturnType<typeof setTimeout> | undefined; let pending = Promise.resolve();
      const binding = { root, file, model, sessionId: null as number | null, ready: null as unknown as Promise<LanguageSnapshot>, flush: async () => {}, dispose: () => {} } as LanguageBinding;
      const startSession = async () => { const session = await start(root); binding.sessionId = session.id; if (live && active) await api.open(session.id, file, model.getValue(), model.getVersionId()); return session; };
      binding.ready = startSession();
      void binding.ready.catch(report);
      const flush = () => {
        clearTimeout(timer);
        pending = pending.catch(() => {}).then(async () => { const session = await binding.ready; if (live && active && !model.isDisposed()) await api.change(session.id, file, model.getValue(), model.getVersionId()); });
        return pending;
      };
      const changed = model.onDidChangeContent(() => { monaco!.editor.setModelMarkers(model, markerOwner, []); clearTimeout(timer); timer = setTimeout(() => { void flush().catch(report); }, 120); });
      const disposed = model.onWillDispose(() => { bindings.delete(uri); dispose(); });
      function dispose() { if (!live) return; live = false; clearTimeout(timer); changed.dispose(); disposed.dispose(); if (!model.isDisposed()) monaco!.editor.setModelMarkers(model, markerOwner, []); void binding.ready.then((session) => api.close(session.id, file)).catch(() => {}); }
      binding.flush = flush; binding.dispose = dispose;
      bindings.set(uri, binding);
      return () => {}; // Open tabs retain their language documents when switching to a panel.
    },
    dispose() {
      active = false; offStatus(); offStore(); offEnvironment(); clear(); providers.forEach((item) => item.dispose());
      const id = latest?.id; if (id !== undefined) void api.stop(id).catch(() => {});
      // A restart triggered just before disabling may already own a newer session; stop whatever the host reports.
      void api.get().then((current) => current ? api.stop(current.id) : undefined).catch(() => {});
      useLanguage.setState({ snapshot: null, error: "", jump: null });
    },
  };
}
