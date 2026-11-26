import type { ToolUsage } from "@grenier/core/api";
import type { ToolUse } from "@grenier/store";
import { Hono } from "hono";
import { installedName } from "../installs.ts";
import { localServers } from "../servers.ts";
import { found } from "../skills.ts";
import { countToolUses, sinceDay, usageOf } from "../tool-uses.ts";
import type { AdminDeps } from "./admin.ts";
import { Missing } from "./request.ts";

/** As Claude Code writes a server's name in its tools' names. */
const calledAs = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, "_");

/** A skill or server here by its id, or the team's by its record, under the name it installs as. */
export function usageRoutes(deps: AdminDeps): Hono {
  const { store, where } = deps;
  const app = new Hono();

  const usage = async (kind: ToolUse["kind"], subjects: string[], suffix: string | null): Promise<ToolUsage> => {
    const now = Date.now();
    const since = sinceDay(now);
    // A plugin's or claude.ai's skill is called by its name after its source's: `<source>:<name>`.
    const rows = suffix
      ? (await store.toolUses.list({ kind, since })).filter(
          (row) => subjects.includes(row.subject) || row.subject.endsWith(`:${suffix}`),
        )
      : await store.toolUses.list({ kind, subjects, since });
    return usageOf(rows, now, (row) => (kind === "skill" ? row.subject : row.tool));
  };

  app.get("/usage", async (c) => {
    await countToolUses(store, where);
    const { skill, server, shared } = c.req.query();
    if (skill) {
      const mine = await found(store, where, skill);
      const own = mine.kind === "own" || mine.kind === "linked";
      return c.json(await usage("skill", [skill.replace(/^\w+:/, ""), mine.name], own ? null : mine.name));
    }
    if (server) {
      const mine = (await localServers(store, where)).find((entry) => entry.id === server);
      if (!mine) throw new Missing("no such server");
      return c.json(await usage("server", [calledAs(mine.name)], null));
    }
    const record = shared ? await store.records.get(shared) : undefined;
    if (record?.type === "Skill") return c.json(await usage("skill", [installedName(record)], null));
    if (record?.type === "McpServer") return c.json(await usage("server", [installedName(record)], null));
    throw new Missing("no such skill or server");
  });

  return app;
}
