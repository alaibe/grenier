import { repoTop } from "@grenier/core";
import { type Consent, remember, retire, StoreUseError } from "@grenier/index";
import { describe, expect, it } from "vitest";
import { answer, deps, PERSON, repo, store } from "./harness.ts";

describe("a member, not an admin", () => {
  it("keeps facts in me, shares answers about the code, and is refused a page for the team", async () => {
    await store.state.set("team_role", "member");
    const fact = await remember(deps, null, repo.repo, { kind: "fact", title: "Standup is at ten" });
    expect(fact.top).toBe("me");
    const kept = await answer("How does routing work?", "route() splits the path on slashes.", ["src/router.ts"]);
    expect(kept.top).toBe(repoTop(repo.repo.id));
    let asked = false;
    const ask = async () => {
      asked = true;
      return { action: "share" } as Consent;
    };
    await expect(
      remember(deps, PERSON, repo.repo, { type: "Doc", title: "Onboarding", top: "team" }, ask),
    ).rejects.toThrow("only an admin writes there");
    expect(asked).toBe(false);
    await expect(retire(deps, fact.id)).resolves.toBe(true);
  });
});

describe("asking first", () => {
  it("records an answer about code without asking, and asks before any other record leaves this machine", async () => {
    const asked: string[] = [];
    const ask = async (record: { title: string }): Promise<Consent> => {
      asked.push(record.title);
      return { action: "share" };
    };
    await remember(deps, PERSON, repo.repo, { kind: "answer", title: "Q?", body: "A.", files: ["src/router.ts"] }, ask);
    const kept = await remember(deps, PERSON, null, { kind: "convention", title: "Tabs, not tops", top: "team" }, ask);
    expect(asked).toEqual(["Tabs, not tops"]);
    expect(kept.top).toBe("team");
  });

  it("keeps the record in me when the person says so, or when the client cannot ask", async () => {
    const toMe = await remember(deps, PERSON, null, { kind: "fact", title: "One", top: "team" }, async () => ({
      action: "me",
    }));
    expect(toMe).toMatchObject({ top: "me", status: "kept in me" });
    const cannot = await remember(deps, PERSON, null, { kind: "fact", title: "Two", top: "team" }, async () => null);
    expect(cannot.top).toBe("me");
  });

  it("drops the record when the person cancels, and takes their edited text", async () => {
    await expect(
      remember(deps, PERSON, null, { kind: "fact", title: "Three", top: "team" }, async () => ({ action: "cancel" })),
    ).rejects.toThrow(StoreUseError);
    const edited = await remember(
      deps,
      PERSON,
      null,
      { kind: "fact", title: "Four", body: "x", top: "team" },
      async () => ({
        action: "edit",
        body: "Edited.",
      }),
    );
    expect((await store.records.get(edited.id))?.body).toBe("Edited.");
  });
});
