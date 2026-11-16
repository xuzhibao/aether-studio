import type { PartViewProps } from "../../plugins/api";
import { usePlugins } from "../../plugins/usePlugins";
export function PluginPart({ schematic, ...props }: PartViewProps & { schematic: boolean }) {
  const definition = usePlugins().get("components", props.comp.kind);
  if (!definition) return <g><rect width={props.comp.w} height={props.comp.h} fill="#F5F6F8" stroke="#C08A2E" strokeDasharray="4 4" /><text x={10} y={24} fontSize={12} fill="#9A702C">{props.comp.name} · 插件未启用</text></g>;
  const Render = schematic ? definition.schematic : definition.render;
  return <Render {...props} />;
}
