import { newVaultKey, open, seal, VaultError } from "@grenier/core";
import { type TeamClient, vaultPull, vaultPush } from "@grenier/index";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import type { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hash, startWorker } from "../../support/worker.ts";

const SECRET_MEMORY = "Marie prefers meetings before ten";
const SECRET_PATH = "/Users/ada/Private/journal";

let mf: Miniflare;
let team: TeamClient;
let otherMember: TeamClient;
let laptop: Store;
let desktop: Store;
let key: string;

beforeAll(async () => {
  ({ mf } = await startWorker());
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO members (id, name, token_hash, role, created_at) VALUES ('m-ada', 'ada', ?, 'admin', 0), ('m-bob', 'bob', ?, 'member', 0)",
    )
    .bind(hash("gt_ada"), hash("gt_bob"))
    .run();
  const fetchFromWorker = ((input: URL | string, init?: RequestInit) =>
    mf.dispatchFetch(String(input), init as never)) as unknown as typeof fetch;
  team = { url: "https://team.test", token: "gt_ada", fetch: fetchFromWorker };
  otherMember = { url: "https://team.test", token: "gt_bob", fetch: fetchFromWorker };
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  key = newVaultKey();
  laptop = openSqliteStore(":memory:");
  desktop = openSqliteStore(":memory:");
  await laptop.items.put({
    id: "memory:m1",
    sourceId: "memory",
    kind: "memory",
    title: "meetings",
    body: SECRET_MEMORY,
    people: [],
    ts: 1,
    contentHash: "h",
  });
  await laptop.sources.add({ id: "s1", name: "journal", kind: "markdown", config: { path: SECRET_PATH } });
});

afterEach(async () => {
  await laptop.close();
  await desktop.close();
});

describe("vault sync through R2", () => {
  it("stores only ciphertext: the R2 object holds none of the plaintext and opens only with the key", async () => {
    expect(await vaultPush(laptop, team, key, "laptop")).toBe(true);

    const object = await (await mf.getR2Bucket("VAULT")).get("vault/m-ada/device-laptop.bin");
    const stored = new Uint8Array(await (object as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
    const asText = new TextDecoder("latin1").decode(stored);
    for (const secret of [SECRET_MEMORY, SECRET_PATH, "journal", "memory:m1", "markdown"]) {
      expect(asText).not.toContain(secret);
    }

    await expect(open(newVaultKey(), "device-laptop.bin", stored)).rejects.toThrow(VaultError);
    const plaintext = new TextDecoder().decode(await open(key, "device-laptop.bin", stored));
    expect(plaintext).toContain(SECRET_MEMORY);
  });

  it("brings the memories and sources of one device to another holding the same key", async () => {
    await vaultPush(laptop, team, key, "laptop");
    expect(await vaultPull(desktop, team, key, "desktop")).toEqual({ memories: 1, sources: 1 });
    expect((await desktop.items.get("memory:m1"))?.body).toBe(SECRET_MEMORY);
    expect((await desktop.sources.get("journal"))?.config).toEqual({ path: SECRET_PATH });
    expect(await vaultPull(desktop, team, key, "desktop")).toEqual({ memories: 0, sources: 0 });
  });

  it("fails to pull with another key, and changes nothing", async () => {
    await vaultPush(laptop, team, key, "laptop");
    await expect(vaultPull(desktop, team, newVaultKey(), "desktop")).rejects.toThrow(
      "cannot be decrypted with this key",
    );
    expect(await desktop.items.get("memory:m1")).toBeUndefined();
  });

  it("keeps each member's objects apart", async () => {
    await vaultPush(laptop, team, key, "laptop");
    const listed = (await (
      await otherMember.fetch?.("https://team.test/api/vault", { headers: { authorization: "Bearer gt_bob" } })
    )?.json()) as {
      objects: { name: string }[];
    };
    expect(listed.objects.map((entry) => entry.name)).not.toContain("device-laptop.bin");
  });

  it("does not push the same snapshot twice", async () => {
    expect(await vaultPush(laptop, team, key, "laptop")).toBe(true);
    expect(await vaultPush(laptop, team, key, "laptop")).toBe(false);
  });
});

describe("seal and open", () => {
  it("refuses a changed byte, another object's name, and a malformed key", async () => {
    const sealed = await seal(key, "a.bin", new TextEncoder().encode("hello"));
    const changed = sealed.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    await expect(open(key, "a.bin", changed)).rejects.toThrow(VaultError);
    await expect(open(key, "b.bin", sealed)).rejects.toThrow(VaultError);
    await expect(seal("not-a-key", "a.bin", new Uint8Array(1))).rejects.toThrow("not a vault key");
    expect(new TextDecoder().decode(await open(key, "a.bin", sealed))).toBe("hello");
  });

  it("uses a fresh IV each time, so the same text never seals the same", async () => {
    const one = await seal(key, "a.bin", new TextEncoder().encode("same"));
    const two = await seal(key, "a.bin", new TextEncoder().encode("same"));
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    expect(newVaultKey()).toMatch(/^gv1_[\w-]{43}$/);
  });
});
