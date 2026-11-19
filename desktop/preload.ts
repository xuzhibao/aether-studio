import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../shared/desktop";
const event = <T>(name: string, callback: (value: T) => void) => { const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value); ipcRenderer.on(name, listener); return () => { ipcRenderer.removeListener(name, listener); }; };
const api: DesktopAPI = {
  esp: { inspect: (port) => ipcRenderer.invoke("esp:inspect", port), preflight: (options) => ipcRenderer.invoke("esp:preflight", options) },
  language: { start: (provider, root, options) => ipcRenderer.invoke("language:start", provider, root, options), restart: (id, options) => ipcRenderer.invoke("language:restart", id, options), stop: (id) => ipcRenderer.invoke("language:stop", id), get: () => ipcRenderer.invoke("language:get"), open: (id, file, text, version) => ipcRenderer.invoke("language:open", id, file, text, version), change: (id, file, text, version) => ipcRenderer.invoke("language:change", id, file, text, version), close: (id, file) => ipcRenderer.invoke("language:close", id, file), request: (id, file, version, method, position) => ipcRenderer.invoke("language:request", id, file, version, method, position), onChanged: (callback) => event("language:changed", callback) },
  terminal: { start: (provider, root, cols, rows) => ipcRenderer.invoke("terminal:start", provider, root, cols, rows), get: () => ipcRenderer.invoke("terminal:get"), stop: (id) => ipcRenderer.invoke("terminal:stop", id), write: (id, data) => ipcRenderer.invoke("terminal:write", id, data), read: (id) => ipcRenderer.invoke("terminal:read", id), resize: (id, cols, rows) => ipcRenderer.invoke("terminal:resize", id, cols, rows), onChanged: (callback) => event("terminal:changed", callback) },
  tools: { list: () => ipcRenderer.invoke("tools:list"), status: (id) => ipcRenderer.invoke("tools:status", id), setPath: (id, value) => ipcRenderer.invoke("tools:setPath", id, value), pick: (id) => ipcRenderer.invoke("tools:pick", id), onChanged: (callback) => event("tools:changed", callback) },
  flash: {
    snapshot: () => ipcRenderer.invoke("flash:snapshot"),
    toolStatus: () => ipcRenderer.invoke("flash:toolStatus"),
    capabilities: () => ipcRenderer.invoke("flash:capabilities"),
    describe: (port) => ipcRenderer.invoke("flash:describe", port),
    chooseBackupPath: (suggestedName) => ipcRenderer.invoke("flash:chooseBackupPath", suggestedName),
    chooseBackupFile: () => ipcRenderer.invoke("flash:chooseBackupFile"),
    readMetadata: (backupPath) => ipcRenderer.invoke("flash:readMetadata", backupPath),
    startBackup: (options) => ipcRenderer.invoke("flash:startBackup", options),
    prepareRestore: (options) => ipcRenderer.invoke("flash:prepareRestore", options),
    executeRestore: (planId, confirmation) => ipcRenderer.invoke("flash:executeRestore", planId, confirmation),
    cancel: () => ipcRenderer.invoke("flash:cancel"),
    onChanged: (callback) => event("flash:changed", callback),
  },
  micropython: {
    list: (port, path) => ipcRenderer.invoke("micropython:files:list", port, path),
    chooseDownloadPath: (suggestedName) => ipcRenderer.invoke("micropython:files:chooseDownloadPath", suggestedName),
    download: (port, path, target) => ipcRenderer.invoke("micropython:files:download", port, path, target),
    cancel: () => ipcRenderer.invoke("micropython:files:cancel"),
  },
  runtime: "electron", window: (action) => ipcRenderer.invoke("window:action", action),
  files: { export: (name, content) => ipcRenderer.invoke("files:export", name, content), import: () => ipcRenderer.invoke("files:import") },
  recovery: { save: (draft) => ipcRenderer.invoke("recovery:save", draft), list: () => ipcRenderer.invoke("recovery:list"), read: (root) => ipcRenderer.invoke("recovery:read", root), clear: (root, revision) => ipcRenderer.invoke("recovery:clear", root, revision), discard: (root) => ipcRenderer.invoke("recovery:discard", root) },
  workspace: {
    open: () => ipcRenderer.invoke("workspace:open"), saveAs: (context) => ipcRenderer.invoke("workspace:saveAs", context), save: (context) => ipcRenderer.invoke("workspace:save", context),
    setDirty: (dirty) => ipcRenderer.invoke("workspace:setDirty", dirty), reload: () => ipcRenderer.invoke("workspace:reload"), close: () => ipcRenderer.invoke("workspace:close"), restore: () => ipcRenderer.invoke("workspace:restore"), onChanged: (callback) => event("workspace:changed", callback),
    files: {
      listing: () => ipcRenderer.invoke("workspace:files:listing"),
      createFile: (path) => ipcRenderer.invoke("workspace:files:createFile", path),
      createDirectory: (path) => ipcRenderer.invoke("workspace:files:createDirectory", path),
      rename: (from, to) => ipcRenderer.invoke("workspace:files:rename", from, to),
      trash: (path) => ipcRenderer.invoke("workspace:files:trash", path),
      write: (path, text, expected) => ipcRenderer.invoke("workspace:files:write", path, text, expected),
      accept: (path, expected) => ipcRenderer.invoke("workspace:files:accept", path, expected),
    },
  },
  tasks: { start: (provider, options) => ipcRenderer.invoke("tasks:start", provider, options), cancel: (id) => ipcRenderer.invoke("tasks:cancel", id), environments: (provider) => ipcRenderer.invoke("tasks:environments", provider), list: () => ipcRenderer.invoke("tasks:list"), onChanged: (callback) => event("tasks:changed", callback) },
  serial: { list: () => ipcRenderer.invoke("serial:list"), open: (port, baud) => ipcRenderer.invoke("serial:open", port, baud), read: (id) => ipcRenderer.invoke("serial:read", id), write: (id, bytes) => ipcRenderer.invoke("serial:write", id, bytes), close: (id) => ipcRenderer.invoke("serial:close", id) },
  serialLog: { save: (request) => ipcRenderer.invoke("serialLog:save", request), invalidate: () => ipcRenderer.invoke("serialLog:invalidate") },
};
contextBridge.exposeInMainWorld("aether", api);
