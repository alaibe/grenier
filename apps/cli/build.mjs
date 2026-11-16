// Bundles the CLI and the workspace packages into dist/grenier.js. better-sqlite3 stays outside: it is a native addon,
// installed as this package's dependency. The team server's Worker is copied into dist/server.
import { existsSync } from "node:fs";
import { chmod, cp, rm } from "node:fs/promises";
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
  loader: { ".sql": "text", ".toml": "text" },
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
await chmod(outfile, 0o755);

// The team server's Worker, which `grenier team deploy` uploads. apps/server builds it first.
await rm("dist/server", { recursive: true, force: true });
if (existsSync("../server/dist/server.js")) await cp("../server/dist", "dist/server", { recursive: true });
