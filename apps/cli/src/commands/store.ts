import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { repoSpace } from "@grenier/core";
import { remember, retire } from "@grenier/index";
import { embedderLoader, repoResolver } from "../exploration.ts";
import { CommandError, environment, type Io, UsageError, withStore } from "../io.ts";
import { storeDeps } from "../runtime.ts";

/**
 * `grenier store [list] [--type <t>] [--space <s>] [--retired]`, `store show <id>`, `store add <type> <title>
 * [--body <text> | --body-file <path>] [--field name=value] [--space <s>]`, `store retire <id>`,
 * `store clear [--repo <path>]`, `store stats`: the records on this machine.
 */
export async function storeCommand(argv: string[], io: Io): Promise<string[]> {
  const [action = "list", ...rest] = argv;
  const { paths, config } = environment(io);
  const embedder = embedderLoader(config, paths, io.err);
  return withStore(paths, async (store) => {
    const deps = await storeDeps(store, config, embedder);
    const spaces = (await store.spaces.list()).map((space) => space.id);
    switch (action) {
      case "list": {
        const { values } = parseArgs({
          args: rest,
          strict: true,
          options: {
            type: { type: "string" },
            space: { type: "string" },
            retired: { type: "boolean", default: false },
          },
        });
        const records = await store.records.list({
          spaces: values.space ? [values.space] : spaces,
          ...(values.type ? { type: values.type } : {}),
          retired: values.retired,
          limit: 200,
        });
        if (records.length === 0) return ["No records yet."];
        return records.map(
          (record) =>
            `${record.id}  ${record.type.padEnd(9)} ${record.space.padEnd(14)} ${record.title}${record.retiredAt ? "  (retired)" : ""}`,
        );
      }
      case "show": {
        const [id] = rest;
        const record = id ? await store.records.get(id) : undefined;
        if (!record) throw new CommandError(`no record ${id ?? ""}`.trim());
        return [
          `${record.type}${record.kind ? ` (${record.kind})` : ""}: ${record.title}`,
          `In ${record.space}, by ${record.author}${record.device ? ` on ${record.device}` : ""}, ${new Date(record.updatedAt).toISOString()}${record.version ? `, version ${record.version}` : ", not yet on the team store"}`,
          ...Object.entries(record.fields).map(([name, value]) => `${name}: ${JSON.stringify(value)}`),
          ...record.anchors.map((anchor) => `from ${anchor.kind === "git" ? "file" : "item"} ${anchor.ref}`),
          ...record.links.map((link) => `links ${link.kind} ${link.ref}`),
          "",
          record.body,
        ];
      }
      case "add": {
        const { values, positionals } = parseArgs({
          args: rest,
          strict: true,
          allowPositionals: true,
          options: {
            body: { type: "string" },
            "body-file": { type: "string" },
            space: { type: "string" },
            field: { type: "string", multiple: true },
          },
        });
        const [type, ...title] = positionals;
        if (!type || title.length === 0) throw new UsageError('store add takes: <type> <title> [--body "…"]');
        const body = values["body-file"] ? readFileSync(resolve(io.cwd, values["body-file"]), "utf8") : values.body;
        const fields: Record<string, unknown> = {};
        for (const entry of values.field ?? []) {
          const at = entry.indexOf("=");
          if (at < 1) throw new UsageError(`--field takes name=value, not ${entry}`);
          fields[entry.slice(0, at)] = entry.slice(at + 1);
        }
        const kept = await remember(deps, null, await repoResolver(io.cwd)(undefined), {
          type,
          title: title.join(" "),
          ...(body ? { body } : {}),
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
          ...(values.space ? { space: values.space } : {}),
        });
        return [`Kept ${kept.id} in ${kept.space}.`];
      }
      case "retire": {
        const [id] = rest;
        if (!id) throw new UsageError("store retire takes a record's id");
        if (!(await retire(deps, id))) throw new CommandError(`no record ${id}, or it is retired already`);
        return [`Retired ${id}: it stays in its history, out of recall and query.`];
      }
      case "clear": {
        const { values } = parseArgs({ args: rest, strict: true, options: { repo: { type: "string" } } });
        const repo = await repoResolver(io.cwd)(values.repo ?? ".");
        if (!repo) throw new CommandError("store clear takes --repo <path> of a git repository");
        const space = repoSpace(repo.id);
        const count = (await store.records.list({ spaces: [space], retired: true, limit: 100_000 })).length;
        await store.spaces.remove(space);
        return [`Removed the ${count} record(s) of ${repo.root} from this machine.`];
      }
      case "stats": {
        const stats = await store.records.stats();
        if (stats.length === 0) return ["No records yet."];
        return stats.map(
          (row) =>
            `${row.space.padEnd(16)} ${row.type.padEnd(10)} ${String(row.records).padStart(6)} records ${String(row.hits).padStart(6)} reuses`,
        );
      }
      default:
        throw new UsageError(
          "store takes: list, show <id>, add <type> <title>, retire <id>, clear --repo <path> or stats",
        );
    }
  });
}
