import type { LanguageProvider } from "../language";
export const clangdProvider: LanguageProvider = {
  id: "clangd", executable: process.env.AETHER_CLANGD_CLI || "clangd",
  args: (root) => ["--background-index=false", "--clang-tidy=false", "--enable-config=false", "--log=error", "--compile-commands-dir=" + root],
};
