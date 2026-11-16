import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/bench.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
