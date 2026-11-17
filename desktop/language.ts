import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, type MessageConnection } from "vscode-jsonrpc/node.js";
import type { CompletionItem, CompletionList, Definition, DefinitionLink, Hover, InitializeResult, PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import { validProjectPath } from "../shared/projectFormat";
import type { LanguageRequest, LanguageSnapshot, Position, DefinitionTarget } from "../shared/language";
import type { WorkspaceService } from "./workspace";
export interface LanguageProvider { id: string; executable: string; args: (root: string) => string[] }
interface Session { snapshot: LanguageSnapshot; child: ChildProcessWithoutNullStreams; rpc: MessageConnection; done: Promise<void> }
const methods = { completion: "textDocument/completion", hover: "textDocument/hover", definition: "textDocument/definition" } as const;
export class LanguageService {
  private providers = new Map<string, LanguageProvider>();
  private session?: Session;
  private sequence = 0;
  constructor(private workspace: WorkspaceService, private changed: (snapshot: LanguageSnapshot) => void = () => {}) {}
  register(provider: LanguageProvider) { if (this.providers.has(provider.id)) throw new Error("Duplicate language provider: " + provider.id); this.providers.set(provider.id, provider); }
  get() { return this.session ? structuredClone(this.session.snapshot) : null; }
  private emit(session: Session) { this.changed(structuredClone(session.snapshot)); }
  private require(id: number) { if (this.session?.snapshot.id !== id || this.session.snapshot.status !== "ready") throw new Error("语言服务会话已关闭"); return this.session; }
  private async uri(session: Session, file: string) {
    if (!validProjectPath(file) || !/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(file)) throw new Error("语言服务仅接受工程内的 C/C++ 文件");
    let current = session.snapshot.root;
    for (const part of file.split("/")) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error("语言服务不通过工程链接打开文件");
    }
    return pathToFileURL(current).href;
  }
  private relative(root: string, uri: string) {
    const file = path.relative(root, fileURLToPath(uri)).split(path.sep).join("/");
    return validProjectPath(file) ? file : null;
  }
  async start(providerId: string, root: string) {
    if (root !== this.workspace.root) throw new Error("请先打开对应磁盘工程");
    if (this.session?.snapshot.provider === providerId && this.session.snapshot.root === root && this.session.snapshot.status === "ready") return this.get()!;
    await this.stop();
    const provider = this.providers.get(providerId); if (!provider) throw new Error("未注册的语言服务：" + providerId);
    const snapshot: LanguageSnapshot = { id: ++this.sequence, provider: providerId, root, status: "starting", compileDatabase: !!await fs.stat(path.join(root, "compile_commands.json")).catch(() => null), error: "", log: "", documents: [] };
    const child = spawn(provider.executable, provider.args(root), { cwd: root, shell: false, windowsHide: true });
    const spawned = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const rpc = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    let resolve!: () => void; const done = new Promise<void>((finish) => { resolve = finish; });
    const session: Session = { snapshot, child, rpc, done }; this.session = session;
    child.stderr.on("data", (chunk: Buffer) => { snapshot.log = (snapshot.log + chunk.toString()).slice(-30000); this.emit(session); });
    child.on("error", (error) => { snapshot.error = error.message; snapshot.status = "error"; this.emit(session); rpc.dispose(); });
    child.on("close", (code, signal) => {
      if (snapshot.status !== "stopped" && snapshot.status !== "error") { snapshot.status = "error"; snapshot.error = `语言服务退出：${signal ?? code}`; }
      snapshot.documents = []; this.emit(session); rpc.dispose(); resolve();
    });
    rpc.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
      const file = this.relative(root, params.uri); const document = snapshot.documents.find((item) => item.file === file);
      if (!document || (params.version !== undefined && params.version !== document.version)) return;
      document.diagnostics = params.diagnostics; this.emit(session);
    });
    rpc.onRequest("workspace/configuration", (params: { items: unknown[] }) => params.items.map(() => null));
    rpc.listen(); this.emit(session);
    try {
      await spawned;
      const initialized = await this.requestWithTimeout<InitializeResult>(session, "initialize", {
        processId: process.pid, rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ name: path.basename(root), uri: pathToFileURL(root).href }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            synchronization: { dynamicRegistration: false }, publishDiagnostics: { versionSupport: true },
            completion: { completionItem: { snippetSupport: true, insertReplaceSupport: false } },
            hover: { contentFormat: ["plaintext"] }, definition: { linkSupport: true },
          },
        },
      });
      if (initialized.capabilities.positionEncoding && initialized.capabilities.positionEncoding !== "utf-16") throw new Error("语言服务未使用 UTF-16 位置编码");
      await rpc.sendNotification("initialized", {});
      snapshot.status = "ready"; this.emit(session); return structuredClone(snapshot);
    } catch (error) { snapshot.status = "error"; snapshot.error ||= String(error); this.emit(session); child.kill(); rpc.dispose(); throw new Error(snapshot.error); }
  }
  private async requestWithTimeout<T>(session: Session, method: string, params: unknown) {
    const cancel = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { cancel.cancel(); reject(new Error("语言服务请求超时：" + method)); }, 15000); });
    try { return await Promise.race([session.rpc.sendRequest<T>(method, params, cancel.token), timeout]); }
    finally { clearTimeout(timer!); cancel.dispose(); }
  }

  async open(id: number, file: string, text: string, version: number) {
    const session = this.require(id); const uri = await this.uri(session, file);
    if (session.snapshot.documents.some((item) => item.file === file)) throw new Error("文档已在语言服务中打开：" + file);
    session.snapshot.documents.push({ file, version, diagnostics: [] });
    await session.rpc.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: /\.c$/i.test(file) ? "c" : "cpp", version, text } }); this.emit(session);
  }
  async change(id: number, file: string, text: string, version: number) {
    const session = this.require(id); const document = session.snapshot.documents.find((item) => item.file === file);
    if (!document || version <= document.version) return;
    document.version = version; document.diagnostics = [];
    await session.rpc.sendNotification("textDocument/didChange", { textDocument: { uri: await this.uri(session, file), version }, contentChanges: [{ text }] }); this.emit(session);
  }
  async close(id: number, file: string) {
    if (this.session?.snapshot.id !== id || this.session.snapshot.status !== "ready") return;
    const session = this.session; session.snapshot.documents = session.snapshot.documents.filter((item) => item.file !== file);
    await session.rpc.sendNotification("textDocument/didClose", { textDocument: { uri: await this.uri(session, file) } }); this.emit(session);
  }
  async request(id: number, file: string, version: number, method: LanguageRequest, position: Position) {
    if (!Object.hasOwn(methods, method)) throw new Error("不支持的语言请求");
    const session = this.require(id); const document = session.snapshot.documents.find((item) => item.file === file);
    if (!document || document.version !== version) return null;
    const result = await this.requestWithTimeout<CompletionItem[] | CompletionList | Hover | Definition | DefinitionLink[] | null>(session, methods[method], { textDocument: { uri: await this.uri(session, file) }, position });
    if (this.session !== session || document.version !== version) return null;
    if (method !== "definition" || !result) return result as CompletionItem[] | CompletionList | Hover | null;
    const locations = Array.isArray(result) ? result : [result]; const targets: DefinitionTarget[] = [];
    for (const value of locations as (DefinitionLink | Exclude<Definition, null | unknown[]>)[]) {
      const uri = "targetUri" in value ? value.targetUri : value.uri;
      const file = this.relative(session.snapshot.root, uri); if (!file) continue;
      targets.push({ file, uri, range: "targetUri" in value ? value.targetSelectionRange : value.range });
    }
    return targets;
  }
  async stop(id?: number) {
    const session = this.session; if (!session || (id !== undefined && id !== session.snapshot.id)) return;
    session.snapshot.status = "stopped"; session.snapshot.documents = []; this.emit(session);
    session.rpc.dispose(); session.child.kill();
    const timer = setTimeout(() => session.child.kill("SIGKILL"), 1500);
    try { await session.done; } finally { clearTimeout(timer); if (this.session === session) this.session = undefined; }
  }
}
