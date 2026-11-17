import { build } from "esbuild";
await Promise.all([
  build({ entryPoints: ["desktop/main.ts"], outfile: "desktop-dist/main.mjs", platform: "node", target: "node22", format: "esm", bundle: true, packages: "external", sourcemap: true }),
  build({ entryPoints: ["desktop/preload.ts"], outfile: "desktop-dist/preload.cjs", platform: "node", target: "node22", format: "cjs", bundle: true, external: ["electron"], sourcemap: true }),
]);
