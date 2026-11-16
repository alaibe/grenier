import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoId, repoRoot } from "@grenier/connectors/git";
import { repoName } from "@grenier/log";
import type { Store } from "@grenier/store";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** Repository names by id, from the sessions that ran in them. */
async function namesById(store: Store): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const session of await store.sessions.list()) {
    if (session.repoId && session.repoRoot) names.set(session.repoId, repoName(session.repoRoot));
  }
  return names;
}

/** A repository given as a path, or as the name of one a session ran in. */
async function repoIdsFor(store: Store, cwd: string, repo: string): Promise<string[]> {
  const path = resolve(cwd, repo);
  if (existsSync(path) && statSync(path).isDirectory()) {
    const root = await repoRoot(path);
    const id = root ? await repoId(root) : null;
    if (id) return [id];
  }
  const ids = [...(await namesById(store)).entries()].filter(([, name]) => name === repo).map(([id]) => id);
  if (ids.length === 0)
    throw new CommandError(`no repository "${repo}" (give its path, or the name of one Grenier has seen)`);
  return ids;
}

/** `grenier cache stats` and `grenier cache clear [--repo <name or path>]`. */
export async function cache(argv: string[], io: Io): Promise<string[]> {
  const [action, ...rest] = argv;
  const { paths } = environment(io);

  if (action === "stats" && rest.length === 0) {
    return withStore(paths, async (store) => {
      const names = await namesById(store);
      const answers = await store.answers.stats();
      const summaries = new Map((await store.summaries.stats()).map((row) => [row.repoId, row.summaries]));
      const ids = [...new Set([...answers.map((row) => row.repoId), ...summaries.keys()])];
      if (ids.length === 0) return ["The cache is empty."];
      const lines = [
        `${"repository".padEnd(24)}${"answers".padStart(9)}${"reused".padStart(9)}${"summaries".padStart(11)}`,
      ];
      for (const id of ids) {
        const row = answers.find((entry) => entry.repoId === id);
        const name = names.get(id) ?? id.slice(0, 12);
        lines.push(
          `${name.padEnd(24)}${String(row?.answers ?? 0).padStart(9)}${String(row?.hits ?? 0).padStart(9)}${String(summaries.get(id) ?? 0).padStart(11)}`,
        );
      }
      return lines;
    });
  }

  if (action === "clear") {
    const { values } = parseArgs({ args: rest, strict: true, options: { repo: { type: "string" } } });
    return withStore(paths, async (store) => {
      const ids = values.repo === undefined ? [undefined] : await repoIdsFor(store, io.cwd, values.repo);
      let answers = 0;
      let summaries = 0;
      for (const id of ids) {
        answers += await store.answers.clear(id);
        summaries += await store.summaries.clear(id);
      }
      return [`Removed ${answers} answer(s) and ${summaries} summary(ies).`];
    });
  }

  throw new UsageError("cache takes: stats, or clear [--repo <name or path>]");
}
