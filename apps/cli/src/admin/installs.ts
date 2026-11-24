import { StoreUseError } from "@grenier/index";
import type { FullRecord } from "@grenier/store";
import { Hono } from "hono";
import { fetchSkill, searchServers, searchSkills } from "../catalog.ts";
import {
  install,
  rollback,
  type Shared,
  serverToShare,
  share,
  sharedList,
  skillFromFiles,
  uninstall,
} from "../installs.ts";
import { Refusal } from "../io.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** The team's skills and servers on this machine, and skills from skills.sh, shared from GitHub like any other. */
export function installRoutes(deps: AdminDeps): Hono {
  const { store } = deps;
  const home = deps.where.home;
  const app = new Hono();

  // What the team store would refuse is a conflict here, as every other refusal of these routes.
  app.onError((error) => {
    if (error instanceof StoreUseError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  });

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
    if (!/^[\w.-]{1,60}$/.test(title)) {
      return c.json({ error: "a server's name takes letters, digits, . _ and -" }, 400);
    }
    const shared = await share(await deps.storeDeps(), {
      type: "McpServer",
      title,
      body: String(input.description ?? "").trim(),
      fields: serverToShare(input),
    });
    return c.json({ ...shared, title });
  });

  app.post("/installs/skill", async (c) => {
    const input = await bodyOf(c);
    const name = String(input.name ?? "").trim();
    const description = String(input.description ?? "")
      .trim()
      .replace(/\s+/g, " ");
    const instructions = String(input.instructions ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      return c.json({ error: "a skill's name takes lowercase letters, digits and -" }, 400);
    }
    if (!description || !instructions) {
      return c.json({ error: "a skill needs a description and its instructions" }, 400);
    }
    const skill = skillFromFiles(
      // A JSON string is a YAML double-quoted scalar: a ": " or a quote in it stays text.
      { "SKILL.md": `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${instructions}\n` },
      name,
    );
    const shared = await share(await deps.storeDeps(), {
      type: "Skill",
      title: skill.name,
      body: "",
      fields: { files: skill.files },
    });
    return c.json({ ...shared, title: skill.name });
  });

  app.post("/installs/share", async (c) => {
    const { source, name } = await bodyOf(c);
    if (typeof source !== "string" || typeof name !== "string") {
      return c.json({ error: "share takes a source and a name" }, 400);
    }
    const skill = await fetchSkill(source, name, deps.fetch);
    const shared = await share(await deps.storeDeps(), {
      type: "Skill",
      title: skill.name,
      body: "",
      fields: { files: skill.files },
    });
    return c.json({ ...shared, title: skill.name, files: Object.keys(skill.files).length });
  });

  app.get("/installs", async (c) => c.json({ shared: await sharedList(store) }));

  /** A skill or server the team has now, or null. */
  const found = async (id: string) => {
    const record = await store.records.get(id);
    return record && (record.type === "Skill" || record.type === "McpServer") && record.retiredAt === null
      ? (record as FullRecord)
      : null;
  };
  const missing = { error: "no such skill or MCP server" };

  app.post("/installs/:id/rollback", async (c) => {
    const record = await found(c.req.param("id"));
    if (!record) return c.json(missing, 404);
    return c.json(await rollback(store, home, record));
  });

  app.post("/installs/:id", async (c) => {
    const record = await found(c.req.param("id"));
    if (!record) return c.json(missing, 404);
    const given = (await bodyOf(c)).keys;
    const keys =
      given && typeof given === "object"
        ? Object.fromEntries(Object.entries(given).map(([name, value]) => [name, String(value)]))
        : {};
    return c.json(await install(store, home, record, { keys }));
  });

  app.delete("/installs/:id", async (c) => {
    const record = await found(c.req.param("id"));
    if (!record) return c.json(missing, 404);
    return c.json({ removed: await uninstall(store, { id: record.id, type: record.type as Shared }) });
  });

  return app;
}
