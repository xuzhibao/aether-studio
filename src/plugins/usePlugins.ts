import { useSyncExternalStore } from "react";
import { plugins } from "./runtime";
export function usePlugins() {
  useSyncExternalStore(plugins.subscribe, plugins.getRevision);
  return plugins;
}
