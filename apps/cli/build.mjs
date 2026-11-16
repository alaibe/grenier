// Bundles the CLI and the workspace packages into dist/grenier.js. better-sqlite3 stays outside: it is a native addon,
// installed as this package's dependency.
import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const outfile = "dist/grenier.js";

await build({
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  loader: { ".sql": "text" },
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
await chmod(outfile, 0o755);
