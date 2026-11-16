// Bundles the Worker into dist/server.js, which `grenier team deploy` uploads, with its migrations beside it.
import { cp } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2023",
  external: ["cloudflare:workers"],
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  logLevel: "warning",
});
await cp("migrations", "dist/migrations", { recursive: true });
