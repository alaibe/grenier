import type { LocalSkill, LocalSkillFull } from "@grenier/core/api";
import { Hono } from "hono";
import { fetchSkill } from "../catalog.ts";
import { shareSkill } from "../installs.ts";
import { skillFromFiles, skillFromForm } from "../skill-files.ts";
import { addLocalSkill, localSkill, localSkills, removeLocalSkill, saveLocalSkill, skillFilesIn } from "../skills.ts";
import type { AdminDeps } from "./admin.ts";
import { bodyOf, queryId, storeConflicts } from "./request.ts";

/** The person's own skills, each agent's: listed, read, written, found on skills.sh and shared with the team. */
export function skillRoutes(deps: AdminDeps): Hono {
  const { store, where } = deps;
  const app = storeConflicts(new Hono());

  app.get("/skills", async (c) => c.json({ skills: (await localSkills(store, where)) satisfies LocalSkill[] }));

  app.get("/skills/one", async (c) => c.json((await localSkill(store, where, queryId(c))) satisfies LocalSkillFull));

  app.post("/skills", async (c) => c.json({ id: addLocalSkill(where, skillFromForm(await bodyOf(c))) }, 201));

  app.post("/skills/found", async (c) => {
    const { source, name } = await bodyOf(c);
    const skill = await fetchSkill(String(source ?? ""), String(name ?? ""), deps.fetch);
    return c.json({ id: addLocalSkill(where, skill) }, 201);
  });

  app.put("/skills/one", async (c) => {
    await saveLocalSkill(store, where, queryId(c), String((await bodyOf(c)).manifest ?? ""));
    return c.json({ saved: true });
  });

  app.delete("/skills/one", async (c) => {
    await removeLocalSkill(store, where, queryId(c));
    return c.json({ removed: true });
  });

  /** An admin shares one of their skills: its folder's text files become a team skill each machine approves. */
  app.post("/skills/share", async (c) => {
    const skill = await localSkill(store, where, queryId(c));
    const files = skillFromFiles(skillFilesIn(skill.path), skill.name).files;
    return c.json(await shareSkill(await deps.storeDeps(), { ...skill, files }));
  });

  return app;
}
