import { repoTop } from "@grenier/core";
import { remember, retire } from "@grenier/index";
import { describe, expect, it } from "vitest";
import { answer, deps, PERSON, repo, store } from "./harness.ts";

describe("a member, not an admin", () => {
  it("keeps facts in me, shares answers about the code, and is refused a page for the team", async () => {
    await store.state.set("team_role", "member");
    const fact = await remember(deps, null, repo.repo, { kind: "fact", title: "Standup is at ten" });
    expect(fact.top).toBe("me");
    const kept = await answer("How does routing work?", "route() splits the path on slashes.", ["src/router.ts"]);
    expect(kept.top).toBe(repoTop(repo.repo.id));
    await expect(remember(deps, PERSON, repo.repo, { type: "Doc", title: "Onboarding", top: "team" })).rejects.toThrow(
      "only an admin writes there",
    );
    await expect(retire(deps, fact.id)).resolves.toBe(true);
  });
});

describe("where a record goes", () => {
  it("keeps an answer about code in its repository's folder, anything else in me, and the team's only when named", async () => {
    const kept = await remember(deps, PERSON, repo.repo, {
      kind: "answer",
      title: "Q?",
      body: "A.",
      files: ["src/router.ts"],
    });
    expect(kept.top).toBe(repoTop(repo.repo.id));
    expect((await remember(deps, PERSON, null, { kind: "convention", title: "Tabs, not spaces" })).top).toBe("me");
    expect((await remember(deps, PERSON, null, { kind: "fact", title: "Named", top: "team" })).top).toBe("team");
  });
});
