import { lineHashes } from "@grenier/gateway";
import { remember } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatEffectiveness } from "../../../apps/cli/src/commands/report.ts";
import { computeOutcomes, effectiveness, LANDING_DAYS } from "../../../apps/cli/src/effectiveness.ts";
import { storeDeps, TestRepo } from "../../support/repo.ts";

const DAY = 86_400_000;
let store: Store;
let repo: TestRepo;
const now = Date.UTC(2026, 10, 22);
const then = now - 20 * DAY;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  repo = new TestRepo({ "router.ts": "export function route() {}\n" });
  await repo.ready();
});

afterEach(async () => {
  await store.close();
  repo.remove();
});

async function session(id: string, at: number, steps: Parameters<Store["steps"]["add"]>[0], cost: number) {
  await store.sessions.create({
    id,
    client: "claude",
    cwd: repo.dir,
    repoRoot: repo.dir,
    repoId: repo.repo.id,
    startedAt: at,
  });
  await store.sessions.end(id, at + 60_000);
  await store.steps.add(steps);
  await store.usage.add({
    sessionId: id,
    ts: at + 1000,
    model: "claude-opus-5-5",
    inputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1,
    cost,
    status: 200,
  });
}

describe("what a session's spend became", () => {
  it("counts the lines that landed on the default branch, the rediscovery and the issues", async () => {
    const written = "export function route(path: string) {\n  return lookup(path);\n}\n";
    const dropped = "const experiment = tryAnotherWay();\n";
    await session(
      "s1",
      then,
      [
        { sessionId: "s1", callId: "c1", ts: then + 10, tool: "Read", kind: "read", path: "router.ts" },
        {
          sessionId: "s1",
          callId: "c2",
          ts: then + 20,
          tool: "Edit",
          kind: "edit",
          path: "router.ts",
          lineHashes: lineHashes(`${written}${dropped}`),
        },
      ],
      2,
    );
    repo.write("router.ts", written);
    repo.git("add", ".");
    repo.gitAt(then + 30_000, "commit", "-q", "-m", "LIN-42 route by path");
    const deps = await storeDeps(store);
    await remember(deps, { id: "c", name: "claude", scopes: ["*"] }, repo.repo, {
      kind: "answer",
      title: "Where are requests routed?",
      body: "route() in router.ts.",
      files: ["router.ts"],
    });
    const recorded = (await store.records.list({ spaces: [`repo:${repo.repo.id}`] }))[0];
    const { seq: _seq, hits: _hits, ...answer } = recorded as NonNullable<typeof recorded>;
    await store.records.put({ ...answer, createdAt: then - DAY });

    expect(await computeOutcomes(store, now)).toBe(1);
    const [outcome] = await store.outcomes.list();
    expect(outcome).toMatchObject({ sessionId: "s1", writtenLines: 3, landedLines: 2, issueKeys: ["LIN-42"] });
    expect(outcome?.rediscovery).toBeCloseTo(1);
    expect(await computeOutcomes(store, now)).toBe(0);

    const result = await effectiveness(store, now - 30 * DAY, now);
    expect(result).toMatchObject({ spend: 2, sessions: 1, perIssue: [{ key: "LIN-42", cost: 2, sessions: 1 }] });
    expect(result.effective).toBeCloseTo(2 * (2 / 3));
    expect(formatEffectiveness(result)).toContain("Landed share: 67%");
  });

  it("waits until a session's edits had time to land", async () => {
    await session(
      "recent",
      now - DAY,
      [
        {
          sessionId: "recent",
          callId: "c1",
          ts: now - DAY,
          tool: "Edit",
          kind: "edit",
          path: "router.ts",
          lineHashes: [],
        },
      ],
      1,
    );
    expect(await computeOutcomes(store, now)).toBe(0);
    const result = await effectiveness(store, now - 30 * DAY, now);
    expect(result.pending).toBe(1);
    expect(formatEffectiveness(result)).toContain(`under ${LANDING_DAYS} days old`);
  });
});
