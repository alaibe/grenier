import { parseArgs } from "node:util";
import { addClient } from "@grenier/index";
import { parseSince } from "@grenier/log";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

/** `grenier clients …`: tokens for the agents and apps that use the store, with the spaces each may read. */
export async function clients(argv: string[], io: Io): Promise<string[]> {
  const [action = "list", ...rest] = argv;
  const { paths } = environment(io);

  if (action === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: { scope: { type: "string", default: "*" } },
    });
    const [name] = positionals;
    if (!name || positionals.length > 1)
      throw new UsageError("clients add takes: <name> [--scope <spaces, or * for all>]");
    const scopes = values.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return withStore(paths, async (store) => {
      let token: string;
      try {
        token = await addClient(store, name, scopes);
      } catch (error) {
        throw new CommandError((error as Error).message);
      }
      return [
        `Created ${name}, reading: ${scopes.length > 0 ? scopes.join(", ") : "the repositories' spaces only"}.`,
        `Its token (shown once): ${token}`,
        "Give it to the app as GRENIER_CLIENT_TOKEN (stdio) or Authorization: Bearer (HTTP).",
      ];
    });
  }

  if (action === "revoke") {
    const [name] = rest;
    if (!name) throw new UsageError("clients revoke takes the client's name");
    return withStore(paths, async (store) =>
      (await store.clients.revoke(name, Date.now()))
        ? [`Revoked ${name}: its next call fails.`]
        : [`No active client named ${name}.`],
    );
  }

  if (action === "list") {
    return withStore(paths, async (store) => {
      return (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map(
          (client) =>
            `${client.name.padEnd(24)}${client.scopes.length > 0 ? client.scopes.join(", ") : "(repositories only)"}`,
        );
    });
  }

  throw new UsageError("clients takes: add <name> --scope <…>, list or revoke <name>");
}

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
