import { remember, retire } from "@grenier/index";
import { describe, expect, it } from "vitest";
import { answer, deps, PERSON, repo, store } from "./harness.ts";

describe("a member, not an admin", () => {
  it("keeps everything in Me, answers about the code too, and is refused a page for the team", async () => {
    await store.state.set("team_role", "member");
    const fact = await remember(deps, null, repo.repo, { title: "Standup is at ten" });
    expect(fact.top).toBe("me");
    const kept = await answer("How does routing work?", "route() splits the path on slashes.", ["src/router.ts"]);
    expect(kept).toMatchObject({ top: "me" });
    await expect(remember(deps, PERSON, repo.repo, { type: "Doc", title: "Onboarding", top: "team" })).rejects.toThrow(
      "only an admin writes in Team",
    );
    await expect(retire(deps, fact.id)).resolves.toBe(true);
  });
});

describe("where a record goes", () => {
  it("keeps an answer about code in Me under its repository's name, anything else in Me, and the team's only when named", async () => {
    const kept = await remember(deps, PERSON, repo.repo, {
      title: "Q?",
      body: "A.",
      files: ["src/router.ts"],
    });
    expect(kept).toMatchObject({ top: "me" });
    const name = (await store.repos.get(repo.repo.id))?.name;
    expect((await store.records.get(kept.id))?.folder).toBe(name);
    expect((await remember(deps, PERSON, null, { title: "Tabs, not spaces" })).top).toBe("me");
    expect((await remember(deps, PERSON, null, { title: "Named", top: "team" })).top).toBe("team");
  });
});
