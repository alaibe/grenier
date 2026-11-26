import type { LocalSkill, LocalSkillFull, SharedNow } from "@grenier/core/api";
import { StoreUseError } from "@grenier/index";
import { Hono } from "hono";
import { fetchSkill } from "../catalog.ts";
import { share, skillFromFiles } from "../installs.ts";
import {
  addLocalSkill,
  localSkill,
  localSkills,
  manifestOf,
  removeLocalSkill,
  saveLocalSkill,
  skillFilesIn,
} from "../skills.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf } from "./body.ts";

/** The person's own skills, in ~/.claude/skills: listed, read, written, found on skills.sh and shared with the team. */
export function skillRoutes(deps: AdminDeps): Hono {
  const { store } = deps;
  const app = new Hono();
  // What the team store would refuse is a conflict here, as in the team's skills.
  app.onError((error) => {
    if (error instanceof StoreUseError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  });
  const id = (query: string | undefined) => String(query ?? "");

  app.get("/skills", async (c) => c.json({ skills: (await localSkills(store, deps.where)) satisfies LocalSkill[] }));

  app.get("/skills/one", async (c) =>
    c.json((await localSkill(store, deps.where, id(c.req.query("id")))) satisfies LocalSkillFull),
  );

  app.post("/skills", async (c) => {
    const input = await bodyOf(c);
    const name = String(input.name ?? "").trim();
    const manifest = manifestOf({
      name,
      description: String(input.description ?? ""),
      instructions: String(input.instructions ?? ""),
    });
    return c.json({ id: addLocalSkill(deps.where, skillFromFiles({ "SKILL.md": manifest }, name)) }, 201);
  });

  app.post("/skills/found", async (c) => {
    const { source, name } = await bodyOf(c);
    const skill = await fetchSkill(String(source ?? ""), String(name ?? ""), deps.fetch);
    return c.json({ id: addLocalSkill(deps.where, skill) }, 201);
  });

  app.put("/skills/one", async (c) => {
    await saveLocalSkill(store, deps.where, id(c.req.query("id")), String((await bodyOf(c)).manifest ?? ""));
    return c.json({ saved: true });
  });

  app.delete("/skills/one", async (c) => {
    await removeLocalSkill(store, deps.where, id(c.req.query("id")));
    return c.json({ removed: true });
  });

  /** An admin shares one of their skills: its folder's text files become a team skill each machine approves. */
  app.post("/skills/share", async (c) => {
    const skill = await localSkill(store, deps.where, id(c.req.query("id")));
    const files = skillFilesIn(skill.path);
    const shared = await share(await deps.storeDeps(), {
      type: "Skill",
      title: skill.name,
      body: "",
      fields: { files: skillFromFiles(files, skill.name).files },
    });
    return c.json({ ...shared, title: skill.name } satisfies SharedNow);
  });

  return app;
}
