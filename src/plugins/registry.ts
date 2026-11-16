import type { CapabilityMap, PluginHost, PluginInfo, StudioPlugin } from "./api";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Contribution = { owner: string; kind: keyof CapabilityMap; value: CapabilityMap[keyof CapabilityMap] };

// One registry and lifecycle for every plugin type. Builtins run in-process.
export class PluginRegistry {
  private plugins = new Map<string, StudioPlugin>();
  private enabled = new Set<string>();
  private activating = new Set<string>();
  private contributions: Contribution[] = [];
  private disposers = new Map<string, (() => void)[]>();
  private listeners = new Set<() => void>();
  private events = new Map<string, Set<(data: unknown) => void>>();
  private preferences: Record<string, boolean>;
  private settings: Record<string, Record<string, string>>;
  private savedSettings: Record<string, Record<string, string>>;
  private revision = 0;
  private host!: PluginHost;
  readonly errors: string[] = [];

  constructor(private storage?: Storage) {
    this.preferences = this.read("aether.plugins.enabled");
    this.savedSettings = this.read("aether.plugins.settings");
    this.settings = structuredClone(this.savedSettings);
  }
  private read(key: string) {
    try {
      const value = JSON.parse(this.storage?.getItem(key) ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置格式错误");
      return value;
    } catch (error) { this.errors.push(`${key}: ${String(error)}`); return {}; }
  }
  connect(host: PluginHost) { this.host = host; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getRevision = () => this.revision;
  private changed() { this.revision++; this.listeners.forEach((fn) => fn()); }
  register(plugin: StudioPlugin) {
    if (this.plugins.has(plugin.manifest.id)) throw new Error(`Duplicate plugin: ${plugin.manifest.id}`);
    this.plugins.set(plugin.manifest.id, plugin);
    this.changed();
  }
  start() {
    for (const plugin of this.plugins.values()) {
      if (this.preferences[plugin.manifest.id] ?? plugin.manifest.enabled) {
        try { this.enable(plugin.manifest.id); } catch (error) { this.errors.push(`${plugin.manifest.id}: ${String(error)}`); }
      }
    }
  }
  enable(id: string) {
    if (this.enabled.has(id)) return;
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Plugin not installed: ${id}`);
    if (this.activating.has(id)) throw new Error(`Plugin dependency cycle: ${id}`);
    this.activating.add(id);
    this.disposers.set(id, []);
    try {
      for (const dep of plugin.manifest.dependencies ?? []) this.enable(dep);
      plugin.activate({
        manifest: plugin.manifest,
        project: { get: () => this.host.getProject() },
        capabilities: { require: (kind, id) => this.require(kind, id) },
        host: {
          getProject: () => this.host.getProject(), log: (text) => this.host.log(text),
          runSimulation: () => this.host.runSimulation(), createProject: (board, template) => this.host.createProject(board, template),
        },
        register: (kind, value) => {
          if (this.contributions.some((c) => c.kind === kind && c.value.id === value.id)) throw new Error(`Duplicate capability: ${kind}/${value.id}`);
          this.contributions.push({ owner: id, kind, value });
        },
        events: { emit: (event, data) => this.emit(event, data), on: (event, fn) => {
          const off = this.on(event, fn); this.disposers.get(id)!.push(off); return off;
        } },
        settings: { get: (key) => this.getSetting(id, key), set: (key, value, persist) => this.setSetting(id, key, value, persist) },
      });
      this.enabled.add(id);
      this.preferences[id] = true;
      this.persist();
      this.changed();
      this.emit("plugin:enabled", id);
    } catch (error) {
      this.cleanup(id);
      throw error;
    } finally { this.activating.delete(id); }
  }
  disable(id: string) {
    if (!this.enabled.has(id)) return;
    const dependent = [...this.plugins.values()].find((p) => this.enabled.has(p.manifest.id) && p.manifest.dependencies?.includes(id));
    if (dependent) throw new Error(`请先停用 ${dependent.manifest.name}`);
    try { this.plugins.get(id)!.deactivate?.(); }
    finally {
      this.cleanup(id);
      this.enabled.delete(id);
      this.preferences[id] = false;
      this.persist();
      this.changed();
      this.emit("plugin:disabled", id);
    }
  }
  unregister(id: string) { this.disable(id); this.plugins.delete(id); this.changed(); }
  private cleanup(id: string) {
    this.disposers.get(id)?.forEach((off) => off());
    this.disposers.delete(id);
    this.contributions = this.contributions.filter((c) => c.owner !== id);
  }
  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => ({ manifest: p.manifest, enabled: this.enabled.has(p.manifest.id), capabilities: this.contributions.filter((c) => c.owner === p.manifest.id).map((c) => `${c.kind}/${c.value.id}`) }));
  }
  all<K extends keyof CapabilityMap>(kind: K): CapabilityMap[K][] { return this.contributions.filter((c) => c.kind === kind).map((c) => c.value as CapabilityMap[K]); }
  get<K extends keyof CapabilityMap>(kind: K, id: string): CapabilityMap[K] | undefined { return this.all(kind).find((c) => c.id === id); }
  require<K extends keyof CapabilityMap>(kind: K, id: string): CapabilityMap[K] {
    const value = this.get(kind, id);
    if (!value) throw new Error(`能力不可用，请在 Plugins 中启用对应插件：${kind}/${id}`);
    return value;
  }
  on(event: string, fn: (data: unknown) => void) {
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event)!.add(fn);
    return () => { this.events.get(event)?.delete(fn); };
  }
  emit(event: string, data?: unknown) { this.events.get(event)?.forEach((fn) => fn(data)); }
  getSetting(id: string, key: string) { return this.settings[id]?.[key] ?? ""; }
  setSetting(id: string, key: string, value: string, persist = true) {
    this.settings[id] = { ...this.settings[id], [key]: value };
    if (persist) {
      this.savedSettings[id] = { ...this.savedSettings[id], [key]: value };
      this.storage?.setItem("aether.plugins.settings", JSON.stringify(this.savedSettings));
    }
    this.changed();
  }
  private persist() { this.storage?.setItem("aether.plugins.enabled", JSON.stringify(this.preferences)); }
}
