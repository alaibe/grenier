import { parseArgs } from "node:util";
import { parseSince } from "@grenier/log";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** `grenier audit [--client <name>] [--since 7d]`: every read a client made of the store, newest first. */
export async function audit(argv: string[], io: Io): Promise<string[]> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { client: { type: "string" }, since: { type: "string", default: "7d" } },
  });
  let since: number;
  try {
    since = parseSince(values.since, Date.now());
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { paths } = environment(io);
  return withStore(paths, async (store) => {
    const all = await store.clients.list();
    const names = new Map(all.map((client) => [client.id, client.name.replace(/~\d+$/, " (revoked)")]));
    const client = values.client ? all.find((entry) => entry.name === values.client) : undefined;
    if (values.client && !client) throw new CommandError(`no client named ${values.client}`);
    const entries = await store.audit.list({ since, ...(client ? { clientId: client.id } : {}) });
    if (entries.length === 0) return ["No reads in this period."];
    return entries.map(
      (entry) =>
        `${new Date(entry.ts).toISOString()}  ${(names.get(entry.clientId) ?? entry.clientId).padEnd(20)} ${entry.tool.padEnd(9)} ${JSON.stringify(entry.args)} → ${entry.recordIds.length} record(s)${
          entry.recordIds.length > 0
            ? `: ${entry.recordIds.slice(0, 5).join(", ")}${entry.recordIds.length > 5 ? ", …" : ""}`
            : ""
        }`,
    );
  });
}
