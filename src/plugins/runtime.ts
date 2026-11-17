import { PluginRegistry } from "./registry";
import { builtinPlugins } from "./builtin";
export const plugins = new PluginRegistry(typeof localStorage === "undefined" ? undefined : localStorage);
for (const plugin of builtinPlugins) plugins.register(plugin);
plugins.start();
