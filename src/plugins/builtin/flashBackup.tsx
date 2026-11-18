import { lazy, Suspense } from "react";
import type { StudioPlugin } from "../api";
// Store-backed UI loads on demand: the plugin registry (and this module) initialize before the stores.
const LazyPanel = lazy(() => import("./FlashBackupPanel").then((module) => ({ default: module.FlashBackupPanel })));
function FlashBackupPanel() { return <Suspense fallback={<div className="p-4 text-xs">Loading flash panel…</div>}><LazyPanel /></Suspense>; }

export const flashBackupPlugin: StudioPlugin = {
  manifest: {
    id: "aether.flash.backup",
    name: "ESP Flash 备份/恢复",
    version: "0.1.0",
    type: "tool",
    entry: "builtin/flashBackup.tsx",
    enabled: true,
    description: "通过本机 esptool 分块读取并校验 ESP Flash，保存到工程之外；恢复前只读比较、列出将写范围、要求显式确认，写入后读回原始字节核对。不修改 eFuse；无法安全写入时明确拒绝。",
    settings: [{ key: "esptool.cli", label: "esptool 可执行文件", type: "tool-path", tool: "esptool", placeholder: "例如 C:/Users/you/.platformio/packages/tool-esptoolpy/esptool.py" }],
    settingsHelp: "本功能只调用这里的单个 esptool 可执行文件或 esptool.py。留空时使用环境变量 AETHER_ESPTOOL，其次在 PATH 中查找 esptool.py。esptool.py 会通过 PlatformIO 自带的 Python 或 PATH 中的 Python 运行；也可直接填写 esptool 的 .exe。路径按单个参数传入，不经过 shell。",
  },
  activate(api) {
    api.register("panels", { id: "flash.backup", name: "Flash 备份/恢复", render: FlashBackupPanel });
    api.register("commands", { id: "flash.backup.open", name: "打开 ESP Flash 备份/恢复", run: async () => { const { useStudio } = await import("../../store/studio"); useStudio.getState().setTab("panel:flash.backup"); } });
  },
};
