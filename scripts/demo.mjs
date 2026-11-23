// Bundles scripts/demo.ts, whose packages import their SQL as text, and runs it from the repository's root.
import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const outdir = "node_modules/.cache/grenier-demo";
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: ["scripts/demo.ts"],
  outfile: `${outdir}/demo.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3", "miniflare"],
  loader: { ".sql": "text", ".toml": "text" },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
});
await import(new URL(`../${outdir}/demo.mjs`, import.meta.url).href);
