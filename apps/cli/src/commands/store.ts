import { parseArgs } from "node:util";
import { repoTop } from "@grenier/core";
import { repoResolver } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** `grenier store clear [--repo <path>]`: removes a repository's records from this machine; the team store keeps them. */
export async function storeCommand(argv: string[], io: Io): Promise<string[]> {
  const [action, ...rest] = argv;
  if (action !== "clear") throw new UsageError("store takes: clear [--repo <path>]");
  const { values } = parseArgs({ args: rest, strict: true, options: { repo: { type: "string" } } });
  const repo = await repoResolver(io.cwd)(values.repo ?? ".");
  if (!repo) throw new CommandError("store clear takes --repo <path> of a git repository");
  const { paths } = environment(io);
  return withStore(paths, async (store) => {
    const top = repoTop(repo.id);
    const count = (await store.records.list({ tops: [top], retired: true, limit: 100_000 })).length;
    await store.tops.remove(top);
    return [`Removed the ${count} record(s) of ${repo.root} from this machine.`];
  });
}
