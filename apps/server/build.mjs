// Bundles the Worker into dist/server.js, which the app's deploy uploads.
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
  loader: { ".css": "text" },
  logLevel: "warning",
});
