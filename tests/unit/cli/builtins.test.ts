import type { StoreDeps } from "@grenier/index";
import { loadPrices } from "@grenier/log";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTINS } from "../../../apps/cli/src/builtins.ts";
import { storeDeps } from "../../support/repo.ts";

let store: Store;
let deps: StoreDeps;

beforeEach(async () => {
  store = openSqliteStore(":memory:");
  deps = await storeDeps(store);
});

afterEach(async () => {
  await store.close();
});

describe("the routines Grenier ships", () => {
  it("each says what it does, and the ones without an agent run here", () => {
    for (const builtin of Object.values(BUILTINS)) {
      expect(builtin.prompt.length).toBeGreaterThan(40);
      expect(builtin.schedule).toMatch(/^(daily|mon|fri) \d\d:\d\d$/);
    }
    expect(Object.entries(BUILTINS).flatMap(([id, builtin]) => (builtin.run ? [id] : []))).toEqual([
      "librarian",
      "digest",
    ]);
  });

  it("writes the week's cost as a page in Me", async () => {
    const result = await BUILTINS.digest?.run?.({ deps, prices: loadPrices(), now: Date.UTC(2026, 10, 30) });
    expect(result).toContain("Cost, week to 2026-11-30");
    const [page] = await store.records.list({ tops: ["me"], type: "Doc" });
    expect(page).toMatchObject({ title: "Cost, week to 2026-11-30", folder: "Cost" });
    expect(page?.body).toContain("$0.00 of API cost");
  });
});
