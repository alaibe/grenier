import { sharedHash } from "@grenier/core";
import type { SharedNow } from "@grenier/core/api";
import type { FullRecord } from "@grenier/store";
import { Hono } from "hono";
import { fetchSkill, searchServers, searchSkills } from "../catalog.ts";
import { install, rollback, type Shared, sharedList, shareServer, shareSkill, uninstall } from "../installs.ts";
import { Refusal } from "../io.ts";
import { BAD_SERVER_NAME, SERVER_NAME, serverToShare, stringRecord } from "../server-config.ts";
import { skillFromFiles, skillFromForm } from "../skill-files.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf, Missing, storeConflicts } from "./request.ts";

/** The team's skills and servers on this machine, and skills from skills.sh, shared from GitHub like any other. */
export function installRoutes(deps: AdminDeps): Hono {
  const { store } = deps;
  const app = storeConflicts(new Hono());

  /** A search's answer: what skills.sh or the MCP Registry said when it failed. */
  const searched = async (find: () => Promise<Record<string, unknown>>) => {
    try {
      return Response.json(await find());
    } catch (error) {
      if (error instanceof Refusal) return Response.json({ error: error.message }, { status: 502 });
      throw error;
    }
  };

  app.get("/installs/search", (c) =>
    searched(async () => ({ skills: await searchSkills(c.req.query("q") ?? "", deps.fetch) })),
  );

  app.get("/installs/registry", (c) =>
    searched(async () => ({ servers: await searchServers(c.req.query("q") ?? "", deps.fetch) })),
  );

  app.post("/installs/server", async (c) => {
    const input = await bodyOf(c);
    const title = String(input.title ?? "").trim();
    if (!SERVER_NAME.test(title)) return c.json({ error: BAD_SERVER_NAME }, 400);
    const description = String(input.description ?? "").trim();
    return c.json(await shareServer(await deps.storeDeps(), title, description, serverToShare(input)));
  });

  app.post("/installs/skill", async (c) =>
    c.json(await shareSkill(await deps.storeDeps(), skillFromForm(await bodyOf(c)))),
  );

  app.post("/installs/share", async (c) => {
    const { source, name } = await bodyOf(c);
    if (typeof source !== "string" || typeof name !== "string") {
      return c.json({ error: "share takes a source and a name" }, 400);
    }
    const skill = await fetchSkill(source, name, deps.fetch);
    const shared = await shareSkill(await deps.storeDeps(), skill);
    return c.json({ ...shared, files: Object.keys(skill.files).length } satisfies SharedNow);
  });

  app.get("/installs", async (c) => c.json({ shared: await sharedList(store) }));

  /** A skill or server the team has now. */
  const found = async (id: string, type?: Shared): Promise<FullRecord> => {
    const record = await store.records.get(id);
    const shared = record && (record.type === "Skill" || record.type === "McpServer") && record.retiredAt === null;
    if (!shared || (type && record.type !== type)) throw new Missing("no such skill or MCP server");
    return record;
  };

  /** An admin's new SKILL.md for a team skill: a new version, which each machine approves again. */
  app.put("/installs/:id/skill", async (c) => {
    const record = await found(c.req.param("id"), "Skill");
    const manifest = String((await bodyOf(c)).manifest ?? "");
    const files = { ...((record.fields.files ?? {}) as Record<string, string>), "SKILL.md": manifest };
    const skill = skillFromFiles(files, record.title);
    return c.json(await shareSkill(await deps.storeDeps(), { ...skill, name: record.title }));
  });

  app.post("/installs/:id/rollback", async (c) =>
    c.json(await rollback(store, deps.where, await found(c.req.param("id")))),
  );

  /** Installs it as the person saw it: a `hash` that is no longer the record's is refused, as nothing they approved. */
  app.post("/installs/:id", async (c) => {
    const record = await found(c.req.param("id"));
    const input = await bodyOf(c);
    const hash = await sharedHash(record);
    if (typeof input.hash === "string" && input.hash !== hash) {
      throw new Refusal(`${record.title} changed since you opened it: look at it again, then install it`);
    }
    return c.json(await install(store, deps.where, record, { hash, keys: stringRecord(input.keys) }));
  });

  app.delete("/installs/:id", async (c) => {
    const record = await found(c.req.param("id"));
    return c.json({ removed: await uninstall(store, deps.where, record.id, record.type as Shared) });
  });

  return app;
}
