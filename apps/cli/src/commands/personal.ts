import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { syncSources } from "@grenier/connectors";
import { addClient, approveMemory, SCOPE_KINDS } from "@grenier/index";
import { parseSince } from "@grenier/log";
import type { Source } from "@grenier/store";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";

function passwordConfig(values: { "password-command"?: string; "password-env"?: string }): Record<string, unknown> {
  if (values["password-command"]) return { password_command: values["password-command"].split(" ").filter(Boolean) };
  if (values["password-env"]) return { password_env: values["password-env"] };
  throw new UsageError('give --password-command "<command printing the password>" or --password-env <VAR>');
}

/** `grenier sources …`: add, list, sync and remove personal-data sources. */
export async function sources(argv: string[], io: Io): Promise<string[]> {
  const [action = "list", ...rest] = argv;
  const { paths } = environment(io);

  if (action === "add") {
    const [kind, name, where, ...more] = rest;
    if (!kind || !name || !where) {
      throw new UsageError("sources add takes: <markdown|ics|caldav|imap> <name> <path, url or host> [options]");
    }
    if (!/^[\w.@-]{1,64}$/.test(name) || (SCOPE_KINDS as readonly string[]).includes(name) || name === "memory") {
      throw new UsageError(`a source name takes letters, digits and . _ @ -, and cannot be ${SCOPE_KINDS.join(", ")}`);
    }
    let source: { kind: Source["kind"]; config: Record<string, unknown> };
    switch (kind) {
      case "markdown":
        source = { kind: "markdown", config: { path: resolve(io.cwd, where) } };
        break;
      case "ics":
        source = {
          kind: "ics",
          config: /^https?:\/\//.test(where) ? { url: where } : { path: resolve(io.cwd, where) },
        };
        break;
      case "caldav": {
        const { values } = parseArgs({
          args: more,
          strict: true,
          options: {
            user: { type: "string" },
            "password-command": { type: "string" },
            "password-env": { type: "string" },
            calendar: { type: "string", multiple: true },
          },
        });
        if (!values.user) throw new UsageError("sources add caldav needs --user");
        source = {
          kind: "caldav",
          config: {
            url: where,
            username: values.user,
            ...passwordConfig(values),
            ...(values.calendar ? { calendars: values.calendar } : {}),
          },
        };
        break;
      }
      case "imap": {
        const { values } = parseArgs({
          args: more,
          strict: true,
          options: {
            user: { type: "string" },
            port: { type: "string" },
            "password-command": { type: "string" },
            "password-env": { type: "string" },
            mailbox: { type: "string", multiple: true },
            "since-days": { type: "string" },
          },
        });
        if (!values.user) throw new UsageError("sources add imap needs --user");
        source = {
          kind: "imap",
          config: {
            host: where,
            user: values.user,
            ...(values.port ? { port: Number(values.port) } : {}),
            ...passwordConfig(values),
            ...(values.mailbox ? { mailboxes: values.mailbox } : {}),
            ...(values["since-days"] ? { since_days: Number(values["since-days"]) } : {}),
          },
        };
        break;
      }
      default:
        throw new UsageError(`unknown source kind "${kind}": markdown, ics, caldav or imap`);
    }
    return withStore(paths, async (store) => {
      if (await store.sources.get(name)) throw new CommandError(`there is already a source named ${name}`);
      await store.sources.add({ id: randomUUID(), name, ...source });
      const [result] = await syncSources(store, io.err, name);
      return [
        `Added ${name} (${source.kind}).`,
        result?.error ? `The first sync failed: ${result.error}` : `It holds ${result?.added ?? 0} item(s).`,
        `Clients read it once their scope names it: grenier clients add <name> --scope ${name}`,
      ];
    });
  }

  if (action === "sync") {
    const [name] = rest;
    return withStore(paths, async (store) => {
      const results = await syncSources(store, io.err, name);
      if (name && results.length === 0) throw new CommandError(`no source named ${name}`);
      return results.map((result) =>
        result.error
          ? `${result.name}: failed, ${result.error}`
          : `${result.name}: ${result.added} new or changed, ${result.removed} removed`,
      );
    });
  }

  if (action === "remove") {
    const [name] = rest;
    if (!name || name === "memory") throw new UsageError("sources remove takes the name of a source you added");
    return withStore(paths, async (store) =>
      (await store.sources.remove(name)) ? [`Removed ${name} and its items.`] : [`No source named ${name}.`],
    );
  }

  if (action === "list") {
    return withStore(paths, async (store) => {
      const counts = new Map((await store.items.count()).map((row) => [row.sourceId, row.items]));
      return (await store.sources.list()).map(
        (source) =>
          `${source.name.padEnd(20)}${source.kind.padEnd(10)}${String(counts.get(source.id) ?? 0).padStart(7)} items   ${
            source.lastSync ? `synced ${new Date(source.lastSync).toISOString()}` : "never synced"
          }${source.vault ? "   in the vault" : ""}`,
      );
    });
  }

  throw new UsageError("sources takes: add, list, sync [name] or remove <name>");
}

/** `grenier clients …`: tokens for the apps that read personal data, with their scope. */
export async function clients(argv: string[], io: Io): Promise<string[]> {
  const [action = "list", ...rest] = argv;
  const { paths } = environment(io);

  if (action === "add") {
    const { values, positionals } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: { scope: { type: "string", default: "" } },
    });
    const [name] = positionals;
    if (!name || positionals.length > 1) throw new UsageError("clients add takes: <name> --scope <sources or kinds>");
    const scopes = values.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    return withStore(paths, async (store) => {
      const known = new Set([...SCOPE_KINDS, ...(await store.sources.list()).map((source) => source.name)]);
      const unknown = scopes.filter((scope) => !known.has(scope));
      if (unknown.length > 0) {
        throw new CommandError(`unknown scope ${unknown.join(", ")}: use ${[...known].join(", ")}`);
      }
      let token: string;
      try {
        token = await addClient(store, name, scopes);
      } catch (error) {
        throw new CommandError((error as Error).message);
      }
      return [
        `Created ${name}, reading: ${scopes.length > 0 ? scopes.join(", ") : "no personal data"}.`,
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
    return withStore(paths, async (store) =>
      (await store.clients.list())
        .filter((client) => client.revokedAt === null)
        .map(
          (client) =>
            `${client.name.padEnd(24)}${client.scopes.length > 0 ? client.scopes.join(", ") : "(no personal data)"}`,
        ),
    );
  }

  throw new UsageError("clients takes: add <name> --scope <…>, list or revoke <name>");
}

/** `grenier audit [--client <name>] [--since 7d]`: every read of personal data, newest first. */
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
        `${new Date(entry.ts).toISOString()}  ${(names.get(entry.clientId) ?? entry.clientId).padEnd(20)} ${entry.tool.padEnd(9)} ${JSON.stringify(entry.args)} → ${entry.itemIds.length} item(s)${
          entry.itemIds.length > 0
            ? `: ${entry.itemIds.slice(0, 5).join(", ")}${entry.itemIds.length > 5 ? ", …" : ""}`
            : ""
        }`,
    );
  });
}

/** `grenier review`, `review approve <id>`, `review reject <id>`: the memories AI tools proposed. */
export async function review(argv: string[], io: Io): Promise<string[]> {
  const [action = "list", id] = argv;
  const { paths } = environment(io);
  return withStore(paths, async (store) => {
    if (action === "list") {
      const names = new Map((await store.clients.list()).map((client) => [client.id, client.name]));
      const pending = await store.review.list("pending");
      if (pending.length === 0) return ["Nothing to review."];
      return pending.flatMap((entry) => [
        `${entry.id}  from ${names.get(entry.clientId) ?? entry.clientId}, ${new Date(entry.ts).toISOString()}${
          entry.tags.length > 0 ? `  [${entry.tags.join(", ")}]` : ""
        }`,
        ...entry.text.split("\n").map((line) => `+ ${line}`),
        "",
      ]);
    }
    if (!id) throw new UsageError(`review ${action} takes the id of a pending memory`);
    if (action === "approve") {
      if (!(await approveMemory({ store }, id))) throw new CommandError(`no pending memory ${id}`);
      return [`Approved ${id}: clients with the memory scope can read it.`];
    }
    if (action === "reject") {
      if (!(await store.review.decide(id, "rejected", Date.now()))) throw new CommandError(`no pending memory ${id}`);
      return [`Rejected ${id}.`];
    }
    throw new UsageError("review takes: list, approve <id> or reject <id>");
  });
}
