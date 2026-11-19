import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../apps/cli/dist/grenier.js", import.meta.url));
const ICS = readFileSync(new URL("../fixtures/calendar/team.ics", import.meta.url), "utf8");

let dir: string;
let home: string;
let notes: string;

async function grenier(...args: string[]) {
  const { stdout } = await promisify(execFile)(BINARY, args, {
    cwd: dir,
    env: { PATH: process.env.PATH, GRENIER_HOME: home },
  });
  return stdout;
}

function tokenFrom(output: string): string {
  return /token \(shown once\): (gc_\S+)/.exec(output)?.[1] ?? "";
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: BINARY,
      args: ["mcp", "serve"],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", GRENIER_HOME: home, GRENIER_CLIENT_TOKEN: token },
      stderr: "pipe",
    }),
  );
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

const ids = (result: Awaited<ReturnType<typeof call>>) =>
  ((result.structuredContent as { items?: { id: string }[] } | undefined)?.items ?? []).map((item) => item.id);

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-e2e-personal-")));
  home = join(dir, ".grenier");
  notes = join(dir, "notes");
  mkdirSync(notes);
  writeFileSync(
    join(notes, "trip.md"),
    "---\ntitle: Lisbon trip\npeople: [Marie Curie]\n---\nFlights on Friday. Call +351 912 345 678.\n",
  );
  writeFileSync(join(dir, "team.ics"), ICS);

  const free = createServer();
  await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
  const port = (free.address() as AddressInfo).port;
  await new Promise((resolve) => free.close(resolve));
  await grenier("status");
  writeFileSync(join(home, "config.toml"), `[proxy]\nport = ${port}\n\n[cache]\nembeddings = "off"\n`);
});

afterAll(async () => {
  await grenier("stop").catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("personal data through the built binary", () => {
  let reader = "";
  let outsider = "";

  it("adds sources and reads them", async () => {
    expect(await grenier("sources", "add", "markdown", "journal", notes)).toContain("It holds 1 item(s).");
    expect(await grenier("sources", "add", "ics", "work", join(dir, "team.ics"))).toContain("It holds 2 item(s).");
    expect(await grenier("sources")).toMatch(/^journal\s+markdown\s+1 items/m);
  });

  it("gives each client the scope it was given, redacted and marked as untrusted", async () => {
    reader = tokenFrom(await grenier("clients", "add", "planner", "--scope", "notes,calendar"));
    outsider = tokenFrom(await grenier("clients", "add", "coder"));

    const found = await call(reader, "search", { query: "Lisbon flights" });
    expect(ids(found)).toEqual([expect.stringMatching(/^[\w-]+:[0-9a-f]{24}$/)]);
    const text = JSON.stringify(found);
    expect(text).toContain("title: Lisbon trip");
    expect(text).not.toContain("trip.md");
    expect(text).toContain("[phone removed]");
    expect(text).toMatch(/untrusted-data-[0-9a-f]{12}/);
    expect(ids(await call(reader, "people", { name: "marie" }))).toHaveLength(2);
    expect(ids(await call(outsider, "search", { query: "Lisbon flights" }))).toEqual([]);
  });

  it("logs every read, per client", async () => {
    const log = await grenier("audit", "--client", "planner");
    expect(log).toMatch(/planner\s+people\s+\{"name":"marie"\} → 2 item\(s\)/);
    expect(log).toMatch(/planner\s+search\s+\{"query":"Lisbon flights"\} → 1 item\(s\): [\w-]+:trip\.md/);
    expect(await grenier("audit", "--client", "coder")).toMatch(/coder\s+search .* → 0 item\(s\)/);
  });

  it("queues a remembered fact until the user approves it", async () => {
    const proposed = (await call(outsider, "remember", { text: "The user flies on Fridays.", tags: ["travel"] }))
      .structuredContent as { id: string };
    expect(await grenier("review")).toContain("+ The user flies on Fridays.");
    expect(await grenier("review", "approve", proposed.id)).toContain("Approved");
    const memory = tokenFrom(await grenier("clients", "add", "assistant", "--scope", "memory"));
    const ref = createHash("sha256").update(`memory:${proposed.id}`).digest("hex").slice(0, 24);
    expect(ids(await call(memory, "search", { query: "flies Fridays" }))).toEqual([`memory:${ref}`]);
  });

  it("picks up an edited note while the daemon watches the folder", async () => {
    await grenier("start");
    writeFileSync(join(notes, "garden.md"), "# Garden\n\nPlant the tulips in October.\n");
    let found = "";
    for (let tries = 0; tries < 40 && !found.includes("tulips"); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      found = JSON.stringify(await call(reader, "search", { query: "tulips" }));
    }
    expect(found).toContain("title: Garden");
  }, 30_000);

  it("stops a revoked client at its next call", async () => {
    expect(await grenier("clients", "revoke", "planner")).toContain("its next call fails");
    const refused = await call(reader, "search", { query: "Lisbon" });
    expect(refused.isError).toBe(true);
    expect(await grenier("clients")).not.toContain("planner");
  });
});
