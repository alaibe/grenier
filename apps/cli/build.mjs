// better-sqlite3 stays outside the bundle: it is a native addon, installed as this package's dependency.
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
  // CommonJS dependencies call require(), which an ES module has to be given.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
});
await chmod(outfile, 0o755);

// apps/server builds the Worker first.
await rm("dist/server", { recursive: true, force: true });
if (existsSync("../server/dist/server.js")) await cp("../server/dist", "dist/server", { recursive: true });
