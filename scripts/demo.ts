// The desktop app on made-up data at http://localhost:1420, for the site's screenshots; ~/.grenier is never touched.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHashes, repoId, repoPath, repoText, trackedFiles } from "@grenier/connectors/git";
import { joinCode, newVaultKey, routineHash, sha256, sharedHash } from "@grenier/core";
import { newId, type StoreDeps, syncOnce, type TeamClient, teamApi, write } from "@grenier/index";
import type { RecordInput, Store } from "@grenier/store";
import { openSqliteStore } from "@grenier/store/sqlite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

// Run from the repository's root by `pnpm demo`, after `pnpm build`.
const ROOT = process.cwd();
const SETUP_TOKEN = `gt_demo_setup_${"0".repeat(40)}`;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const DAY = 86_400_000;
const now = Date.now();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return typeof address === "object" && address ? address.port : 0;
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "grenier-demo-")));
const home = join(dir, "grenier");
const userHome = join(dir, "home");
const repo = join(dir, "checkout");
mkdirSync(home);
mkdirSync(userHome);
mkdirSync(join(repo, "src"), { recursive: true });

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Marie",
      GIT_AUTHOR_EMAIL: "marie@example.com",
      GIT_COMMITTER_NAME: "Marie",
      GIT_COMMITTER_EMAIL: "marie@example.com",
    },
  });
const files: Record<string, string> = {
  "src/router.ts": "export function route(path: string) {\n  return routes.find((entry) => entry.matches(path));\n}\n",
  "src/payments/retry.ts":
    "export async function retry(payment: Payment) {\n  await queue.push({ id: payment.id, attempt: payment.attempt + 1 });\n}\n",
  "src/money.ts": "export const cents = (amount: number) => Math.round(amount * 100);\n",
  "README.md": "# checkout\n",
};
git("init", "-q", "-b", "main");
for (const [path, text] of Object.entries(files)) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
}
git("add", ".");
git("commit", "-q", "-m", "First version of checkout");
const repoIdentity = (await repoId(repo)) as string;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: join(ROOT, "apps/server/dist/server.js"),
    compatibilityDate: "2026-11-01",
    durableObjects: { TEAM: { className: "TeamStore", useSQLite: true } },
    bindings: { SETUP_HASH: hash(SETUP_TOKEN) },
    host: "127.0.0.1",
    port: await freePort(),
  }),
);
const teamUrl = (await mf.ready).origin;
const teamFetch = fetch;
const marie: TeamClient = { url: teamUrl, token: SETUP_TOKEN, fetch: teamFetch };
await teamApi(marie, "/api/setup", { body: { member: "marie", device: "marie-mbp" } });

async function joinTeam(name: string, device: string, role = "member"): Promise<TeamClient> {
  const invite = await teamApi<{ id: string; secret: string }>(marie, "/api/invites", { body: { name, role } });
  const token = `gt_demo_${device}_${newId()}${newId()}`;
  const nonce = newId().padEnd(32, "0");
  await fetch(`${teamUrl}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite: invite.id, secret: invite.secret, device, tokenHash: hash(token), nonce }),
  });
  await teamApi(marie, "/api/invites/confirm", { body: { code: await joinCode(await sha256(invite.secret), nonce) } });
  return { url: teamUrl, token, fetch: teamFetch };
}
const sam = await joinTeam("sam", "sam-thinkpad");
const lea = await joinTeam("lea", "lea-pc", "admin");
const anthony = await joinTeam("anthony", "anthony-mbp", "admin");
await teamApi(marie, "/api/invites", { body: { name: "noor" } });

const store: Store = openSqliteStore(join(home, "grenier.db"));
await store.tops.put({ id: "me", name: "me", kind: "me", repoId: null, root: null });
await store.tops.put({ id: "team", name: "team", kind: "team", repoId: null, root: null });
await store.tops.put({
  id: `repo:${repoIdentity}`,
  name: "checkout",
  kind: "repo",
  repoId: repoIdentity,
  root: repo,
});
const me = await teamApi<{ me: string }>(marie, "/api/me");
await store.state.set("team_member", "marie");
await store.state.set("team_me_top", me.me);
const personalKey = newVaultKey();
writeFileSync(join(home, "personal.key"), `${personalKey}\n`, { mode: 0o600 });
const deps: StoreDeps = {
  store,
  files: { hashes: blobHashes, tracked: trackedFiles, relative: repoPath, text: repoText },
  embedder: null,
  me: { member: "marie", device: "marie-mbp" },
};

const teammates: Record<string, TeamClient> = { sam, lea, anthony };

/** A record by marie on this machine, or by a teammate with their own token: the store names the sender as author. */
async function record(input: Partial<RecordInput> & Pick<RecordInput, "type" | "title">): Promise<string> {
  const id = input.id ?? newId();
  const full: RecordInput = {
    id,
    top: "team",
    kind: null,
    folder: "",
    body: "",
    fields: {},
    author: "marie",
    device: "marie-mbp",
    sessionId: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    version: 0,
    anchors: [],
    links: [],
    ...input,
  };
  const teammate = teammates[full.author];
  if (!teammate) {
    await write(deps, full);
    return id;
  }
  const changed = ["top", "type", "kind", "title", "folder", "body", "fields", "anchors", "links"];
  await teamApi(teammate, "/api/changes", {
    body: { changes: [{ id: newId(), recordId: id, baseVersion: 0, changed, record: full }] },
  });
  return id;
}
async function anchored(paths: string[]) {
  const hashes = await blobHashes(repo, paths);
  return paths.map((path) => ({
    kind: "git" as const,
    repoId: repoIdentity,
    ref: path,
    version: hashes.get(path) as string,
  }));
}
const link = (id: string) => ({ kind: "record" as const, ref: id });

const project = await record({
  id: "5c3f0a1e9b2d4c6e8a7f1b3d",
  type: "Project",
  title: "Checkout",
  folder: "Projects",
  fields: { owner: "marie", status: "active", repos: [repoIdentity] },
  body: "The new checkout: one page, retries that never charge twice, and Apple Pay by January.\n\n## Goals\n\n- Fewer abandoned carts\n- No double charge, ever\n- Apple Pay before the sales",
});
const decision = await record({
  type: "Decision",
  title: "Retry failed payments from a queue",
  folder: "Projects/Checkout/Decisions",
  fields: { owner: "marie", date: "2026-11-18", reason: "A retry in the request doubled a charge twice last month." },
  body: "Failed payments go to the payments queue and are retried there, with the attempt number as the idempotency key.",
  links: [link(project)],
});
await record({
  id: "8e2b6d4f1a3c5e7b9d0f2a4c",
  type: "Meeting",
  title: "Checkout weekly",
  folder: "Projects/Checkout/Meetings",
  author: "lea",
  device: "sam-thinkpad",
  fields: { date: "2026-11-18", people: ["marie", "sam", "lea", "anthony"] },
  body: `Marie, Sam, Léa and Anthony.\n\n- Payments retried in the request doubled two charges: [Retry failed payments from a queue](record:${decision}).\n- Léa takes Apple Pay; Sam moves the retries.\n- Anthony keeps the dependencies up to date with the routine.`,
  links: [link(project), link(decision)],
});
await record({
  type: "Task",
  title: "Move payment retries to the queue",
  author: "lea",
  device: "sam-thinkpad",
  fields: { status: "doing", owner: "sam" },
  links: [link(project), link(decision)],
});
await record({
  type: "Task",
  title: "Add Apple Pay",
  author: "lea",
  device: "lea-pc",
  fields: { status: "to-do", owner: "lea" },
  links: [link(project)],
});
await record({
  type: "Task",
  title: "One-page checkout",
  fields: { status: "done", owner: "marie" },
  links: [link(project)],
});
await record({
  type: "Doc",
  title: "How to run checkout locally",
  folder: "Onboarding",
  body: "## Setup\n\n1. `pnpm install`\n2. Copy `.env.example` to `.env`\n3. `pnpm dev`, then open http://localhost:3000\n\nPayments use the test keys of the sandbox; **never** a live key.",
  links: [link(project)],
});
await record({
  type: "Doc",
  title: "Template: Postmortem",
  body: "## What happened\n\n## Why\n\n## What we change",
});
const retryAnswer = await record({
  top: `repo:${repoIdentity}`,
  type: "Memory",
  kind: "answer",
  title: "Where are failed payments retried?",
  folder: "Payments",
  author: "sam",
  device: "sam-thinkpad",
  fields: { kind: "answer" },
  body: "In `src/payments/retry.ts`: `retry()` pushes the payment back on the queue with the next attempt number.",
  anchors: await anchored(["src/payments/retry.ts"]),
  links: [{ kind: "repo", ref: repoIdentity }, link(decision)],
});
const routing = await record({
  top: `repo:${repoIdentity}`,
  type: "Memory",
  kind: "answer",
  title: "How are requests routed?",
  author: "lea",
  device: "lea-pc",
  fields: { kind: "answer" },
  body: "`route()` in `src/router.ts` returns the first route that matches the path.",
  anchors: await anchored(["src/router.ts"]),
  links: [{ kind: "repo", ref: repoIdentity }],
});
const cents = await record({
  type: "Memory",
  kind: "convention",
  title: "Money is always in cents",
  folder: "Conventions",
  fields: { kind: "convention" },
  body: "Amounts are integers in cents everywhere; `cents()` in src/money.ts converts at the edges.",
});
await record({
  top: "me",
  type: "Memory",
  kind: "fact",
  title: "Review Léa's Apple Pay PR before Friday",
  fields: { kind: "fact" },
});
const skill = await record({
  type: "Skill",
  title: "release-notes",
  author: "lea",
  device: "lea-pc",
  fields: {
    files: {
      "SKILL.md":
        "---\nname: release-notes\ndescription: Writes release notes from the pull requests merged since the last tag.\n---\nRead the merged pull requests, group them by area, write one line each.\n",
    },
  },
});
await record({
  type: "McpServer",
  title: "sentry",
  author: "anthony",
  device: "anthony-mbp",
  fields: {
    config: { command: "npx", args: ["-y", "@sentry/mcp-server@0.24.0"] },
    credentials: ["SENTRY_ACCESS_TOKEN"],
  },
  body: "Sentry's issues and events, read-only for agents.",
});
const update = await record({
  type: "Routine",
  title: "Update dependencies",
  author: "anthony",
  device: "anthony-mbp",
  fields: {
    trigger: "request",
    repo: repoIdentity,
    tools: ["Edit", "Bash(pnpm install:*)", "Bash(pnpm test:*)"],
  },
  body: "Update the dependencies the request names to their newest release older than 7 days, run the tests, and explain what changed.",
});
await record({
  type: "Routine",
  title: "Librarian",
  fields: {
    trigger: "schedule",
    schedule: "daily 05:00",
    builtin: "librarian",
  },
  body: "Built in: looks through the store for stale memories, duplicates, broken rules and orphaned requests, and suggests fixes.",
});
await record({
  type: "Routine",
  title: "My meetings",
  fields: {
    trigger: "schedule",
    schedule: "weekdays 18:00",
    collector: "yes",
    tools: ["mcp__granola__list_meetings", "mcp__granola__get_transcript"],
  },
  body: "Gather today's meeting transcripts as Meeting records, linked to their project.",
});
await record({
  type: "Task",
  title: "Bump hono to 4.12",
  author: "marie",
  fields: {
    status: "done",
    routine: update,
    machine: "anthony-mbp",
    result: "Bumped hono from 4.11.2 to 4.12.0. The tests pass. Nothing in checkout used the removed `c.env` getter.",
  },
  links: [link(update)],
});
writeFileSync(
  join(repo, "src/payments/retry.ts"),
  `${files["src/payments/retry.ts"]}\nexport const MAX_ATTEMPTS = 5;\n`,
);
git("commit", "-q", "-am", "PAY-112 cap retries at five attempts");
await record({
  type: "Suggestion",
  title: "Where are failed payments retried?: Its files changed since it was written",
  folder: "Suggestions",
  author: "marie",
  fields: {
    target: retryAnswer,
    change: { retire: true },
    reason: "Its files changed since it was written (src/payments/retry.ts): check it again, or retire it.",
  },
  links: [link(retryAnswer)],
});
await syncOnce({ store, team: marie, embedder: null, personalKey });
for (const [id, times] of [
  [retryAnswer, 7],
  [routing, 4],
  [cents, 9],
] as const) {
  for (let n = 0; n < times; n++) await store.records.hit(id);
}

await store.approvals.put({
  recordId: update,
  kind: "routine",
  hash: await routineHash(
    (await store.records.get(update)) as NonNullable<Awaited<ReturnType<Store["records"]["get"]>>>,
  ),
  approvedAt: now,
  settings: { mode: "read-only", limit: 10 },
  installedPath: null,
  previousHash: null,
});
await store.approvals.put({
  recordId: skill,
  kind: "skill",
  hash: await sharedHash((await store.records.get(skill)) as NonNullable<Awaited<ReturnType<Store["records"]["get"]>>>),
  approvedAt: now,
  settings: { auto: true, name: "release-notes" },
  installedPath: join(userHome, ".claude", "skills", "grenier-release-notes"),
  previousHash: null,
});

// Teammates' machines say their state again before the team store counts them as offline.
const tellStates = async () => {
  for (const [client, state, room] of [
    [lea, "available", 0.7],
    [sam, "away", 0.2],
    [anthony, "busy", 0.4],
  ] as const) {
    await teamApi(client, "/api/machines/me", {
      method: "PUT",
      body: { state, room, repos: [repoIdentity], agents: ["claude"] },
    }).catch(() => undefined);
  }
};
await tellStates();
const stateTimer = setInterval(() => void tellStates(), 60_000);
const day = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
for (const [client, scale] of [
  [marie, 1.4],
  [sam, 2.1],
  [lea, 1.1],
  [anthony, 0.8],
] as const) {
  const rows = Array.from({ length: 14 }, (_, ago) => ({
    day: day(ago),
    repo: "checkout",
    requests: Math.round(40 * scale + ((ago * 7) % 11)),
    inputTokens: 200_000,
    cacheWriteTokens: 40_000,
    cacheReadTokens: 900_000,
    outputTokens: 30_000,
    cost: Number((scale * (2.2 + ((ago * 13) % 7) / 3)).toFixed(2)),
    routineMinutes: client === anthony ? 12 + (ago % 3) * 6 : 0,
  }));
  await teamApi(client, "/api/usage", { method: "PUT", body: { rows } });
}
const runs = [
  { status: "done", ago: 3, actions: 2 },
  { status: "done", ago: 0.2, actions: 3 },
];
for (const run of runs) {
  await teamApi(anthony, "/api/runs", {
    body: {
      id: newId(),
      routineId: update,
      status: run.status,
      startedAt: now - run.ago * DAY,
      endedAt: now - run.ago * DAY + 6 * 60_000,
      actions: run.actions,
      cost: 0.41,
    },
  });
}

const sessions = [
  { client: "claude", ago: 0.1, cost: 1.84 },
  { client: "claude", ago: 0.9, cost: 0.62 },
  { client: "codex", ago: 2, cost: 2.4 },
  { client: "claude", ago: 3.5, cost: 0.97 },
  { client: "claude", ago: 5, cost: 3.1 },
];
for (const [index, session] of sessions.entries()) {
  const id = `demo${index}`;
  const at = now - session.ago * DAY;
  await store.sessions.create({
    id,
    client: session.client,
    cwd: repo,
    repoRoot: repo,
    repoId: repoIdentity,
    startedAt: at,
  });
  await store.sessions.end(id, at + 25 * 60_000);
  for (let n = 0; n < 6; n++) {
    await store.usage.add({
      sessionId: id,
      ts: at + n * 60_000,
      model: session.client === "codex" ? "gpt-5.5" : "claude-opus-5-5",
      inputTokens: 12_000,
      cacheWriteTokens: 3_000,
      cacheReadTokens: 60_000,
      outputTokens: 2_000,
      cost: session.cost / 6,
      status: 200,
    });
  }
}
await store.close();

const port = await freePort();
const adminToken = `ga_demo_${newId()}${newId()}`;
writeFileSync(join(home, "admin-token"), `${adminToken}\n`, { mode: 0o600 });
writeFileSync(join(home, "team-token"), `${SETUP_TOKEN}\n`, { mode: 0o600 });
writeFileSync(
  join(home, "config.toml"),
  `[proxy]\nport = ${port}\n\n[store]\nembeddings = "off"\n\n[team]\nurl = "${teamUrl}"\n\n[machine]\nname = "marie-mbp"\nroutines = true\nidle_minutes = 0\nhours = "0-24"\n`,
);
const environment = { ...process.env, GRENIER_HOME: home, HOME: userHome };
const daemon = spawn(process.execPath, [join(ROOT, "apps/cli/dist/grenier.js"), "daemon"], {
  env: environment,
  stdio: ["ignore", "ignore", "inherit"],
});
for (let tries = 0; tries < 50; tries++) {
  const up = await fetch(`http://127.0.0.1:${port}/admin/health`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
    .then((response) => response.ok)
    .catch(() => false);
  if (up) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const vite = join(ROOT, "apps/desktop/node_modules/vite/bin/vite.js");
const ui = join(dir, "ui");
execFileSync(process.execPath, [vite, "build", "--outDir", ui, "--emptyOutDir", "--logLevel", "warn"], {
  cwd: join(ROOT, "apps/desktop"),
  env: { ...process.env, VITE_GRENIER_URL: `http://127.0.0.1:${port}`, VITE_GRENIER_TOKEN: adminToken },
  stdio: "inherit",
});
const preview = spawn(
  process.execPath,
  [vite, "preview", "--outDir", ui, "--port", "1420", "--strictPort", "--host", "localhost"],
  {
    cwd: join(ROOT, "apps/desktop"),
    stdio: ["ignore", "ignore", "inherit"],
  },
);

process.on("exit", () => {
  preview.kill();
  daemon.kill();
});
process.stdout.write(
  `Grenier's demo: http://localhost:1420/demo#knowledge (or #knowledge/${project}, #cost, #routines, #skills, #mcp, #team, #settings). Ctrl-C stops it.\n`,
);
await new Promise<void>((resolve) => {
  process.once("SIGINT", () => resolve());
  process.once("SIGTERM", () => resolve());
});
clearInterval(stateTimer);
preview.kill();
daemon.kill();
await mf.dispose();
rmSync(dir, { recursive: true, force: true });
