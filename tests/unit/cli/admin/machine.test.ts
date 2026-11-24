import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newVaultKey } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import { remember } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testAdmin } from "../../../support/gateway.ts";
import { storeDeps } from "../../../support/repo.ts";

let store: Store;
let home: string;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-connect-"));
  mkdirSync(join(home, ".grenier"));
});

afterEach(async () => {
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

let rounds: number;

/** The routes, and the body of a route's answer. */
function routes() {
  rounds = 0;
  const route = testAdmin(store, home, {
    sync: async (between) => {
      await between?.();
      rounds += 1;
      return null;
    },
  }).reply;
  const body = async <T>(method: string, path: string, input?: unknown): Promise<T> =>
    (await route(method, path, input)).body as T;
  return { route, body };
}

describe("the personal key for the Me folder", () => {
  it("is made once and shown when asked, and another machine's replaces it: Me goes out again sealed with it", async () => {
    const { route, body } = routes();
    const shown = (await body<{ key: string }>("POST", "/key")).key;
    expect((await body<{ key: string }>("POST", "/key")).key).toBe(shown);
    expect((await route("PUT", "/key", { key: "not-a-key" }))?.status).toBe(400);
    expect(await route("PUT", "/key", { key: shown })).toEqual({ status: 200, body: { saved: true, unopened: 0 } });
    expect(rounds).toBe(0);

    const deps = await storeDeps(store);
    const mine = await remember(deps, null, null, { kind: "fact", title: "Dentist on Tuesday", top: "me" });
    await store.outbox.remove((await store.outbox.list()).map((entry) => entry.id));
    await store.state.set("team_cursor", "42");
    await store.state.set("team_unopened", JSON.stringify(["sealed-elsewhere"]));
    expect(await body("GET", "/key")).toEqual({ unopened: 1 });

    const other = newVaultKey();
    expect(await route("PUT", "/key", { key: other })).toEqual({ status: 200, body: { saved: true, unopened: 0 } });
    expect(readFileSync(resolvePaths({ GRENIER_HOME: join(home, ".grenier") }).personalKey, "utf8").trim()).toBe(other);
    expect((await store.outbox.list()).map((entry) => entry.recordId)).toEqual([mine.id]);
    expect(await store.state.get("team_cursor")).toBe("0");
    expect(rounds).toBe(1);
  });
});

describe("the machine's rules", () => {
  it("are written to config.toml, and a rule it does not know is refused as the person's mistake", async () => {
    const { route } = routes();
    expect(await route("PUT", "/machine", { rules: { speed: 1 } })).toEqual({
      status: 400,
      body: { error: "[machine] has no speed" },
    });
    expect(await route("PUT", "/machine", { rules: { routines: true } })).toMatchObject({
      status: 200,
      body: { rules: { routines: true } },
    });
    expect(readFileSync(resolvePaths({ GRENIER_HOME: join(home, ".grenier") }).config, "utf8")).toContain(
      "routines = true",
    );
  });
});
