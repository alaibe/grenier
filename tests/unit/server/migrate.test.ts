import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN, startWorker } from "../../support/worker.ts";

let persist: string;

beforeEach(async () => {
  persist = await mkdtemp(join(tmpdir(), "grenier-team-store-"));
});

afterEach(async () => {
  await rm(persist, { recursive: true, force: true });
});

const setUp = (call: Awaited<ReturnType<typeof startWorker>>["call"]) =>
  call("/api/setup", SETUP_TOKEN, { body: { member: "ada", device: "ada-mbp" } });

describe("the team store's migrations", () => {
  it("make a fresh store, and run once: a restart keeps what it holds", async () => {
    const first = await startWorker({ persist });
    expect((await setUp(first.call)).status).toBe(201);
    const pushed = await first.call("/api/changes", SETUP_TOKEN, {
      body: {
        changes: [
          {
            id: "c1",
            recordId: "r1",
            baseVersion: 0,
            changed: ["top", "title"],
            record: { top: "team", title: "Hello" },
          },
        ],
      },
    });
    expect(await pushed.json()).toMatchObject({ applied: [{ id: "c1", version: 1 }] });
    await first.mf.dispose();

    const again = await startWorker({ persist });
    expect((await setUp(again.call)).status).toBe(409);
    expect(await (await again.call("/api/me", SETUP_TOKEN)).json()).toMatchObject({ name: "ada", version: 1 });
    expect(await (await again.call("/api/records?q=hello", SETUP_TOKEN)).json()).toMatchObject({
      records: [{ id: "r1", title: "Hello" }],
    });
    await again.mf.dispose();
  }, 60_000);
});
