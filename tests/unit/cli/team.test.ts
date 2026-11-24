import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import { openSqliteStore } from "@grenier/store/sqlite";
import { describe, expect, it, vi } from "vitest";
import { TeamLink } from "../../../apps/cli/src/link.ts";
import { parseInvite } from "../../../apps/cli/src/team.ts";

describe("the link to the team store", () => {
  it("runs a step between two rounds, never while a round writes the cursor", async () => {
    const home = mkdtempSync(join(tmpdir(), "grenier-link-"));
    const store = openSqliteStore(":memory:");
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const team = {
      url: "https://team.test",
      token: "gt_x",
      fetch: (async () => {
        order.push("round");
        await held;
        throw new Error("offline");
      }) as unknown as typeof fetch,
    };
    const link = new TeamLink(
      team,
      store,
      defaultConfig(),
      resolvePaths({ GRENIER_HOME: home }),
      async () => null,
      () => {},
    );
    const first = link.sync();
    const second = link.sync(async () => {
      order.push("between");
    });
    await vi.waitFor(() => expect(order).toEqual(["round"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["round"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["round", "between", "round"]);
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("invite links", () => {
  it("name the team store's host, the invite and its secret", () => {
    expect(parseInvite("grenier://join/grenier-team.acme.workers.dev/ab12/cd34")).toEqual({
      url: "https://grenier-team.acme.workers.dev",
      invite: "ab12",
      secret: "cd34",
    });
    expect(parseInvite("grenier://join/127.0.0.1:8787/ab/cd").url).toBe("http://127.0.0.1:8787");
    expect(() => parseInvite("https://example.com")).toThrow("grenier://join/");
  });
});
