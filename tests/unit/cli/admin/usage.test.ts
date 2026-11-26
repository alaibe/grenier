import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolUsage } from "@grenier/core/api";
import type { Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testAdmin } from "../../../support/gateway.ts";

let store: Store;
let home: string;
let transcript: string;

beforeEach(() => {
  store = openSqliteStore(":memory:");
  home = mkdtempSync(join(tmpdir(), "grenier-usage-"));
  mkdirSync(join(home, ".claude", "skills", "release-notes"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: Writes notes.\n---\nRead the log.\n",
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example/mcp" } } }),
  );
  mkdirSync(join(home, ".claude", "projects", "-work-app"), { recursive: true });
  transcript = join(home, ".claude", "projects", "-work-app", "session.jsonl");
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
  rmSync(home, { recursive: true, force: true });
});

const today = new Date().toISOString();
const line = (content: unknown, cwd = "/work/app") =>
  `${JSON.stringify({ type: "assistant", timestamp: today, cwd, message: { content } })}\n`;
const call = (id: string, name: string, input: unknown = {}) => line([{ type: "tool_use", id, name, input }]);
const failed = (id: string) => line([{ type: "tool_result", tool_use_id: id, is_error: true, content: "no" }]);

describe("how this machine's agents used a skill or a server", () => {
  it("counts a skill's loads and a server's calls by tool from Claude Code's transcripts, reading each line once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const route = testAdmin(store, home).reply;
    appendFileSync(
      transcript,
      call("t1", "Skill", { skill: "release-notes" }) +
        line("<command-name>/release-notes</command-name>", "/work/other") +
        call("t2", "mcp__docs__search") +
        call("t3", "mcp__docs__search") +
        failed("t3") +
        call("t4", "mcp__docs__fetch") +
        call("t5", "Bash") +
        '{"cut short',
    );

    const skill = (await route("GET", "/usage?skill=claude%3Arelease-notes"))?.body as ToolUsage;
    expect(skill).toMatchObject({ calls: 2, errors: 0, projects: [{ calls: 1 }, { calls: 1 }] });
    expect(skill.days).toHaveLength(30);
    expect(skill.days.at(-1)).toMatchObject({ calls: 2 });

    const servers = (await route("GET", "/servers"))?.body as { servers: { id: string; name: string }[] };
    const docs = servers.servers.find((server) => server.name === "docs")?.id ?? "";
    const server = (await route("GET", `/usage?server=${encodeURIComponent(docs)}`))?.body as ToolUsage;
    expect(server).toMatchObject({
      calls: 3,
      errors: 1,
      tools: [
        { tool: "search", calls: 2, errors: 1 },
        { tool: "fetch", calls: 1, errors: 0 },
      ],
    });

    appendFileSync(transcript, `"}\n${call("t6", "mcp__docs__fetch")}`);
    const soon = (await route("GET", `/usage?server=${encodeURIComponent(docs)}`))?.body as ToolUsage;
    expect(soon.calls).toBe(3);
    vi.setSystemTime(Date.now() + 60_000);
    const again = (await route("GET", `/usage?server=${encodeURIComponent(docs)}`))?.body as ToolUsage;
    expect(again.calls).toBe(4);
  });

  it("answers 404 for a team record that is no skill or server", async () => {
    const route = testAdmin(store, home).reply;
    expect((await route("GET", "/usage?shared=nothing"))?.status).toBe(404);
  });
});
