import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react(), { name: "production-csp", apply: "build", transformIndexHtml() { return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' https: http: ws: wss:" }, injectTo: "head-prepend" }]; } }],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",

  },
  build: {
    target: "chrome105",
    minify: "esbuild",
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: { include: ["monaco-editor"] },
});
