import { describe, expect, it } from "vitest";
import { fetchSkill, searchServers, searchSkills } from "../../../apps/cli/src/catalog.ts";
import { fakeWeb, REPO, SHA } from "../../support/catalog.ts";

describe("searching skills.sh", () => {
  it("sends only the words, and keeps the results that name a skill and its GitHub repository", async () => {
    const { asked, fetchImpl } = fakeWeb();
    expect(await searchSkills("  release notes ", fetchImpl)).toEqual([
      { id: "acme/skills/release-notes", name: "release-notes", source: "acme/skills", installs: 1200 },
      { id: "acme/tools/lint", name: "lint", source: "acme/tools", installs: 3 },
    ]);
    expect(asked).toEqual(["https://skills.sh/api/search?q=release+notes"]);
    expect(await searchSkills("   ", fetchImpl)).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});

describe("fetching a skill from GitHub", () => {
  it("takes the folder whose SKILL.md names it, at one commit, without hidden files", async () => {
    const { asked, fetchImpl } = fakeWeb();
    const skill = await fetchSkill("acme/skills", "release-notes", fetchImpl);
    expect(skill).toEqual({
      name: "release-notes",
      description: "Writes release notes.",
      files: { "SKILL.md": REPO["skills/notes/SKILL.md"], "template.md": "## Changes\n" },
    });
    expect(
      asked.filter((url) => url.includes("raw.githubusercontent.com")).every((url) => url.includes(`/${SHA}/`)),
    ).toBe(true);
    expect(asked.some((url) => url.endsWith(".env"))).toBe(false);
  });

  it("refuses a skill too large to share before fetching its files, and a source that is not owner/repo", async () => {
    const { asked, fetchImpl } = fakeWeb({ ...REPO, "skills/notes/big.md": "x".repeat(200_001) });
    await expect(fetchSkill("acme/skills", "release-notes", fetchImpl)).rejects.toThrow(
      "release-notes is too large: a shared skill holds at most",
    );
    expect(asked.some((url) => url.endsWith("big.md"))).toBe(false);
    await expect(fetchSkill("acme/skills", "missing", fetchImpl)).rejects.toThrow("no skill named missing");
    for (const source of ["../etc", "acme/..", "acme/.", "acme/skills/extra", "-acme/skills"]) {
      await expect(fetchSkill(source, "x", fetchImpl)).rejects.toThrow("owner/repo");
    }
  });
});

describe("searching the MCP Registry", () => {
  const entry = (server: Record<string, unknown>) => ({ server: { version: "1.0.0", ...server }, _meta: {} });
  const registry = (servers: unknown[]) => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      asked.push(String(input));
      return Response.json({ servers });
    }) as typeof fetch;
    return { asked, fetchImpl };
  };

  it("sends only the words, and keeps the servers it can share as they are, pinned, with the keys each person enters", async () => {
    const { asked, fetchImpl } = registry([
      entry({
        name: "app.linear/linear",
        title: "Linear",
        description: "Issues.",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.linear.app/mcp",
            headers: [{ name: "Authorization", value: "Bearer {api_key}", isSecret: true }],
          },
        ],
      }),
      entry({
        name: "io.github.acme/sentry",
        version: "2.1.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@sentry/mcp",
            version: "2.1.0",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "SENTRY_TOKEN", isSecret: true },
              { name: "SENTRY_HOST", isRequired: true, default: "sentry.io" },
            ],
          },
        ],
      }),
      entry({
        name: "io.github.acme/files",
        packages: [
          {
            registryType: "npm",
            identifier: "files-mcp",
            version: "1.0.0",
            transport: { type: "stdio" },
            packageArguments: [{ type: "positional", isRequired: true, valueHint: "dir" }],
          },
        ],
      }),
      entry({
        name: "io.github.acme/postgres",
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/acme/postgres:0.1.3",
            transport: { type: "stdio" },
            runtimeArguments: [{ type: "named", name: "-v", value: "/:/host" }],
            environmentVariables: [{ name: "DATABASE_URL", isRequired: true, isSecret: true }],
          },
        ],
      }),
      entry({
        name: "io.github.acme/both",
        packages: [
          { registryType: "oci", identifier: "acme/both", version: "2.0.0", transport: { type: "stdio" } },
          { registryType: "npm", identifier: "both-mcp", version: "2.0.0", transport: { type: "stdio" } },
        ],
      }),
      entry({
        name: "io.github.acme/unpinned",
        packages: [{ registryType: "oci", identifier: "ghcr.io/acme/x:latest", transport: { type: "stdio" } }],
      }),
    ]);
    const found = await searchServers("  issues ", fetchImpl);
    expect(asked).toEqual([
      "https://registry.modelcontextprotocol.io/v0/servers?search=issues&version=latest&limit=30",
    ]);
    expect(found.map(({ name, config, credentials }) => ({ name, config, credentials }))).toEqual([
      {
        name: "app.linear/linear",
        config: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer {api_key}" } },
        credentials: ["api_key"],
      },
      {
        name: "io.github.acme/sentry",
        config: { command: "npx", args: ["-y", "@sentry/mcp@2.1.0"], env: { SENTRY_HOST: "sentry.io" } },
        credentials: ["SENTRY_TOKEN"],
      },
      {
        name: "io.github.acme/postgres",
        config: {
          command: "docker",
          args: ["run", "-i", "--rm", "-e", "DATABASE_URL", "ghcr.io/acme/postgres:0.1.3"],
        },
        credentials: ["DATABASE_URL"],
      },
      {
        name: "io.github.acme/both",
        config: { command: "npx", args: ["-y", "both-mcp@2.0.0"] },
        credentials: [],
      },
    ]);
  });
});
