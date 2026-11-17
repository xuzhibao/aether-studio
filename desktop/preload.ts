import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../shared/desktop";
const event = <T>(name: string, callback: (value: T) => void) => { const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value); ipcRenderer.on(name, listener); return () => { ipcRenderer.removeListener(name, listener); }; };
const api: DesktopAPI = {
  language: { start: (provider, root) => ipcRenderer.invoke("language:start", provider, root), stop: (id) => ipcRenderer.invoke("language:stop", id), get: () => ipcRenderer.invoke("language:get"), open: (id, file, text, version) => ipcRenderer.invoke("language:open", id, file, text, version), change: (id, file, text, version) => ipcRenderer.invoke("language:change", id, file, text, version), close: (id, file) => ipcRenderer.invoke("language:close", id, file), request: (id, file, version, method, position) => ipcRenderer.invoke("language:request", id, file, version, method, position), onChanged: (callback) => event("language:changed", callback) },
  runtime: "electron", window: (action) => ipcRenderer.invoke("window:action", action),
  files: { export: (name, content) => ipcRenderer.invoke("files:export", name, content), import: () => ipcRenderer.invoke("files:import") },
  workspace: {
    open: () => ipcRenderer.invoke("workspace:open"), saveAs: (context) => ipcRenderer.invoke("workspace:saveAs", context), save: (context) => ipcRenderer.invoke("workspace:save", context),
    setDirty: (dirty) => ipcRenderer.invoke("workspace:setDirty", dirty), reload: () => ipcRenderer.invoke("workspace:reload"), close: () => ipcRenderer.invoke("workspace:close"), restore: () => ipcRenderer.invoke("workspace:restore"), onChanged: (callback) => event("workspace:changed", callback),
  },
  tasks: { start: (provider, options) => ipcRenderer.invoke("tasks:start", provider, options), cancel: (id) => ipcRenderer.invoke("tasks:cancel", id), list: () => ipcRenderer.invoke("tasks:list"), onChanged: (callback) => event("tasks:changed", callback) },
  serial: { list: () => ipcRenderer.invoke("serial:list"), open: (port, baud) => ipcRenderer.invoke("serial:open", port, baud), read: (id) => ipcRenderer.invoke("serial:read", id), write: (id, bytes) => ipcRenderer.invoke("serial:write", id, bytes), close: (id) => ipcRenderer.invoke("serial:close", id) },
};
contextBridge.exposeInMainWorld("aether", api);
