import { ensureRepo, query, recall, remember, retire } from "@grenier/index";
import { describe, expect, it } from "vitest";
import { TableEmbedder, TestRepo } from "../../support/repo.ts";
import { answer, deps, embedWith, PERSON, repo, store } from "./harness.ts";

describe("remember and recall", () => {
  it("keeps an answer in its repository's top with the blob hash of each file, and recalls it as a hit", async () => {
    const kept = await answer("How does routing work?", "route() splits the path on slashes.", ["src/router.ts"]);
    expect(kept).toMatchObject({ top: "me" });
    const record = await store.records.get(kept.id);
    expect(record?.anchors).toEqual([
      { kind: "git", repoId: repo.repo.id, ref: "src/router.ts", version: expect.stringMatching(/^[0-9a-f]{40}$/) },
    ]);
    expect(record?.links).toEqual([{ kind: "repo", ref: repo.repo.id }]);

    const found = await recall(deps, PERSON, { query: "how does routing work", repo: repo.repo });
    expect(found.status).toBe("hit");
    expect(found.results[0]?.id).toBe(kept.id);
    expect((await store.records.get(kept.id))?.hits).toBe(1);
  });

  it("comes back stale with the changed files once one changes, and does not count it as a reuse", async () => {
    const kept = await answer("How does routing work?", "route() splits the path.", ["src/router.ts", "src/server.ts"]);
    repo.write("src/router.ts", "export const route = (p: string) => p;\n");
    const found = await recall(deps, PERSON, { query: "routing work", repo: repo.repo });
    expect(found.status).toBe("stale");
    expect(found.results[0]?.changed).toEqual(["src/router.ts"]);
    expect((await store.records.get(kept.id))?.hits).toBe(0);
  });

  it("is a miss when nothing close is recorded", async () => {
    await answer("How does routing work?", "route() splits the path.", ["src/router.ts"]);
    expect((await recall(deps, PERSON, { query: "database migrations", repo: repo.repo })).status).toBe("miss");
  });

  it("finds a reworded question by its vector", async () => {
    await embedWith(
      new TableEmbedder({ "Where are paths split?": [1, 0, 0], "path splitting location": [0.9, 0.1, 0] }),
    );
    const kept = await answer("Where are paths split?", "In route().", ["src/router.ts"]);
    const found = await recall(deps, PERSON, { query: "path splitting location", repo: repo.repo });
    expect(found.results[0]?.id).toBe(kept.id);
    expect(found.results[0]?.similarity).toBeGreaterThan(0.9);
  });

  it("replaces an answer to the same question in the same repository", async () => {
    const first = await answer("How does routing work?", "Old.", ["src/router.ts"]);
    const second = await answer("how does routing work?", "New.", ["src/router.ts"]);
    expect(second.id).toBe(first.id);
    expect((await store.records.get(first.id))?.body).toBe("New.");
  });

  it("says unchecked for a record that came from an outside item", async () => {
    await remember(deps, PERSON, null, {
      title: "The release freeze starts on Friday",
      body: "As LIN-42 says.",
      items: [{ ref: "linear:acme/LIN-42", version: "2026-11-20T10:00:00Z" }],
      top: "team",
    });
    const found = await recall(deps, PERSON, { query: "release freeze Friday", repo: null });
    expect(found.status).toBe("unchecked");
  });

  it("refuses a file outside the repository, a missing one, and a copy of the code", async () => {
    await expect(answer("Q?", "A.", ["../elsewhere.ts"])).rejects.toThrow("outside the repository");
    await expect(answer("Q?", "A.", ["src/gone.ts"])).rejects.toThrow("no such file");
    const lines = Array.from({ length: 12 }, (_, index) => `const value${index} = ${index};`);
    repo.write("src/long.ts", `${lines.join("\n")}\n`);
    repo.git("add", ".");
    await expect(answer("What is in long.ts?", lines.join("\n"), ["src/long.ts"])).rejects.toThrow("copies 12 lines");
  });

  it("refuses a record holding something like a key, or breaking its type's rules", async () => {
    await expect(
      remember(deps, PERSON, null, {
        title: "Token",
        body: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      }),
    ).rejects.toThrow("looks like a key");
    await expect(remember(deps, PERSON, null, { type: "Task", title: "Ship it", top: "team" })).rejects.toThrow(
      "needs status",
    );
    await expect(remember(deps, PERSON, null, { type: "Nothing", title: "x" })).rejects.toThrow("no type Nothing");
  });

  it("searches the repository the agent is in first", async () => {
    const other = new TestRepo({ "src/router.ts": "export const other = 1;\n" });
    await other.ready();
    await remember(deps, null, other.repo, {
      title: "How does routing work here?",
      body: "Elsewhere.",
      files: ["src/router.ts"],
    });
    const here = await answer("How does routing work?", "Here.", ["src/router.ts"]);
    const found = await recall(deps, PERSON, { query: "how does routing work", repo: repo.repo });
    expect(found.results[0]?.id).toBe(here.id);
    other.remove();
  });
});

describe("query, retire and the outbox", () => {
  it("returns one record with what it links to and what links to it", async () => {
    const plan = await remember(deps, PERSON, null, { title: "Checkout", top: "team" });
    const task = await remember(deps, PERSON, null, {
      type: "Task",
      title: "Checkout kickoff",
      fields: { status: "to-do" },
      links: [{ kind: "record", ref: plan.id }],
      top: "team",
    });
    const result = await query(deps, PERSON, { id: plan.id });
    expect(result.records.map((record) => record.id)).toEqual([plan.id]);
    expect(result.linked?.map((record) => record.id)).toEqual([task.id]);
    expect((await query(deps, PERSON, { type: "Task" })).records.map((record) => record.title)).toEqual([
      "Checkout kickoff",
    ]);
  });

  it("queues every change for the team store, with the fields it touched, and retires without deleting", async () => {
    const kept = await remember(deps, PERSON, null, { title: "Ship on Fridays", top: "team" });
    expect(await retire(deps, kept.id)).toBe(true);
    expect(await retire(deps, kept.id)).toBe(false);
    const changes = (await store.outbox.list()).map((entry) => (entry.change as { changed: string[] }).changed);
    expect(changes[0]).toContain("title");
    expect(changes[1]).toEqual(["retiredAt"]);
    expect((await recall(deps, PERSON, { query: "ship Fridays", repo: null })).status).toBe("miss");
    expect(await store.records.get(kept.id)).toBeDefined();
  });
});

describe("a repository", () => {
  it("keeps where the repository lives, not the checkout a routine's run works in", async () => {
    expect(await ensureRepo(store, { root: "/work/shop", id: "abc" })).toBe("shop");
    await ensureRepo(store, { root: "/tmp/grenier-run-1/shop", id: "abc", home: "/work/shop" });
    expect(await store.repos.get("abc")).toMatchObject({ name: "shop", root: "/work/shop" });
  });
});
