import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "@grenier/core";
import { resolvePaths } from "@grenier/core/node";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deployTeamStore } from "../../../apps/cli/src/deploy.ts";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grenier-deploy-"));
  mkdirSync(join(dir, ".grenier"));
  mkdirSync(join(dir, "server"));
  writeFileSync(join(dir, "server", "server.js"), "export default {};");
  store = openSqliteStore(":memory:");
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "cf_test_token";

/** Cloudflare's API for one account, and the Worker it deploys, which takes setup once with the deployed hash. */
function fakeCloudflare() {
  const scripts = new Set<string>();
  const uploads: Record<string, unknown>[] = [];
  let hash = "";
  let members = 0;
  const said: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    said.push(JSON.stringify([url.pathname, init.headers]));
    const reply = (result: unknown) => Response.json({ success: true, result });
    if (url.hostname === "grenier-team.acme.workers.dev" && url.pathname === "/api/setup") {
      const token = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "");
      if (createHash("sha256").update(token).digest("hex") !== hash)
        return Response.json({ error: "no" }, { status: 401 });
      if (members > 0) return Response.json({ error: "set up already" }, { status: 409 });
      members += 1;
      return Response.json({ member: "ada" }, { status: 201 });
    }
    if ((init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) {
      return Response.json({ success: false, errors: [{ message: "Invalid API Token" }] }, { status: 403 });
    }
    if (url.pathname === "/client/v4/accounts") return reply([{ id: "acc1" }]);
    if (url.pathname === "/client/v4/accounts/acc1/workers/scripts" && !init.method?.includes("PUT")) {
      return reply([...scripts].map((id) => ({ id })));
    }
    if (url.pathname === "/client/v4/accounts/acc1/workers/scripts/grenier-team" && init.method === "PUT") {
      const metadata = JSON.parse(await ((init.body as FormData).get("metadata") as Blob).text());
      uploads.push(metadata);
      hash = metadata.bindings.find((binding: { name: string }) => binding.name === "SETUP_HASH").text;
      scripts.add("grenier-team");
      return reply({ id: "grenier-team" });
    }
    if (url.pathname.endsWith("/workers/scripts/grenier-team/subdomain")) return reply({ enabled: true });
    if (url.pathname === "/client/v4/accounts/acc1/workers/subdomain") return reply({ subdomain: "acme" });
    return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, uploads, said };
}

describe("creating the team store from the app", () => {
  it("deploys it with a pasted token, makes this machine its admin, and updates it in place the next time", async () => {
    const cloudflare = fakeCloudflare();
    const paths = resolvePaths({ GRENIER_HOME: join(dir, ".grenier") });
    const deps = {
      paths,
      config: defaultConfig(),
      store,
      serverDir: join(dir, "server"),
      inTeam: false,
      fetch: cloudflare.fetchImpl,
      sleep: async () => {},
    };
    const made = await deployTeamStore(deps, { token: TOKEN, name: "grenier-team", member: "ada" });
    expect(made.url).toBe("https://grenier-team.acme.workers.dev");
    expect(made.team?.url).toBe(made.url);
    expect(cloudflare.uploads[0]).toMatchObject({
      main_module: "server.js",
      bindings: [{ type: "durable_object_namespace", name: "TEAM", class_name: "TeamStore" }, { name: "SETUP_HASH" }],
      migrations: { new_tag: "v1", new_sqlite_classes: ["TeamStore"] },
    });
    expect(readFileSync(paths.config, "utf8")).toContain('url = "https://grenier-team.acme.workers.dev"');
    expect(statSync(paths.teamToken).mode & 0o777).toBe(0o600);
    expect(await store.state.get("team_role")).toBe("admin");

    const updated = await deployTeamStore(
      { ...deps, inTeam: true },
      { token: TOKEN, name: "grenier-team", member: "ada" },
    );
    expect(updated).toEqual({ url: "https://grenier-team.acme.workers.dev", team: null });
    expect(statSync(paths.deployToken).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.deployToken, "utf8").trim()).toBe(TOKEN);

    const oneClick = await deployTeamStore(
      { ...deps, inTeam: true },
      { token: "", name: "grenier-team", member: "ada" },
    );
    expect(oneClick.url).toBe("https://grenier-team.acme.workers.dev");
    expect(cloudflare.uploads).toHaveLength(3);
    expect(cloudflare.uploads[1]).not.toHaveProperty("migrations");
    expect(readFileSync(paths.config, "utf8")).not.toContain(TOKEN);
  });

  it("refuses a Worker of the same name from a machine in no team, before uploading anything", async () => {
    const cloudflare = fakeCloudflare();
    const deps = {
      paths: resolvePaths({ GRENIER_HOME: join(dir, ".grenier") }),
      config: defaultConfig(),
      store,
      serverDir: join(dir, "server"),
      inTeam: false,
      fetch: cloudflare.fetchImpl,
      sleep: async () => {},
    };
    await deployTeamStore(deps, { token: TOKEN, name: "grenier-team", member: "ada" });
    await store.state.set("team_role", "none");
    const again = deployTeamStore(deps, { token: TOKEN, name: "grenier-team", member: "eve" });
    await expect(again).rejects.toThrow(
      "a Worker named grenier-team exists in this account: pick another name, or join it with an invite",
    );
    expect(cloudflare.uploads).toHaveLength(1);
    expect(await store.state.get("team_role")).toBe("none");
  });

  it("says what the new store refused when it sets up, at once, rather than waiting for it", async () => {
    const cloudflare = fakeCloudflare();
    let asked = 0;
    const deps = {
      paths: resolvePaths({ GRENIER_HOME: join(dir, ".grenier") }),
      config: defaultConfig(),
      store,
      serverDir: join(dir, "server"),
      inTeam: false,
      sleep: async () => {},
      fetch: (async (input: string | URL, init?: RequestInit) => {
        if (!String(input).endsWith("/api/setup")) return cloudflare.fetchImpl(input, init);
        asked++;
        return Response.json({ error: "a name takes letters, digits and . _ -" }, { status: 400 });
      }) as typeof fetch,
    };
    await expect(deployTeamStore(deps, { token: TOKEN, name: "grenier-team", member: "ada" })).rejects.toThrow(
      "it refused to set up: a name takes letters, digits and . _ -",
    );
    expect(asked).toBe(1);
  });

  it("says what Cloudflare refused, never the token", async () => {
    const cloudflare = fakeCloudflare();
    const deps = {
      paths: resolvePaths({ GRENIER_HOME: join(dir, ".grenier") }),
      config: defaultConfig(),
      store,
      serverDir: join(dir, "server"),
      inTeam: false,
      fetch: cloudflare.fetchImpl,
    };
    const refused = deployTeamStore(deps, { token: "cf_wrong_secret", name: "grenier-team", member: "ada" });
    await expect(refused).rejects.toThrow("Cloudflare refused it: Invalid API Token");
    await expect(refused).rejects.not.toThrow("cf_wrong_secret");
    await refused.catch(() => {});
    expect(existsSync(deps.paths.deployToken)).toBe(false);
  });

  it("forgets a kept token Cloudflare refuses, so the next update asks for one", async () => {
    const cloudflare = fakeCloudflare();
    const paths = resolvePaths({ GRENIER_HOME: join(dir, ".grenier") });
    writeFileSync(paths.deployToken, "cf_revoked\n");
    const deps = {
      paths,
      config: defaultConfig(),
      store,
      serverDir: join(dir, "server"),
      inTeam: true,
      fetch: cloudflare.fetchImpl,
    };
    await expect(deployTeamStore(deps, { token: "", name: "grenier-team", member: "ada" })).rejects.toThrow(
      "Cloudflare refused it: Invalid API Token",
    );
    expect(existsSync(paths.deployToken)).toBe(false);
    await expect(deployTeamStore(deps, { token: "", name: "grenier-team", member: "ada" })).rejects.toThrow(
      "paste an API token from Cloudflare",
    );
  });
});
