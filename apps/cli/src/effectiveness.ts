import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { lineHashes } from "@grenier/gateway";
import type { Store } from "@grenier/store";

/** Days a session's edits have to land on the default branch before they are counted. */
export const LANDING_DAYS = 14;
const DAY = 86_400_000;
const ISSUE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b|(?<![\w/])#\d{1,6}\b/g;

export type Git = (root: string, args: string[]) => Promise<string>;

const runGit: Git = async (root, args) =>
  (await promisify(execFile)("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout;

/** The default branch as this clone knows it: origin's HEAD, else main or master, else HEAD. */
async function defaultRef(git: Git, root: string): Promise<string> {
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    try {
      await git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Not there: the next one.
    }
  }
  return "HEAD";
}

/** Works out what each session's spend became once its edits had LANDING_DAYS to land; kept on this machine only. */
export async function computeOutcomes(store: Store, now = Date.now(), git: Git = runGit): Promise<number> {
  const done = new Set((await store.outcomes.list()).map((outcome) => outcome.sessionId));
  let computed = 0;
  for (const summary of await store.steps.sessions(now - 90 * DAY)) {
    if (done.has(summary.sessionId) || summary.last > now - LANDING_DAYS * DAY) continue;
    const session = await store.sessions.get(summary.sessionId);
    if (!session?.repoRoot || session.runId || !existsSync(session.repoRoot)) continue;
    const root = session.repoRoot;
    const steps = await store.steps.list(session.id);

    const written = new Map<string, Set<string>>();
    for (const step of steps) {
      if (step.kind !== "edit" || !step.path || !step.lineHashes) continue;
      const lines = written.get(step.path) ?? new Set<string>();
      for (const hash of step.lineHashes) lines.add(hash);
      written.set(step.path, lines);
    }
    let writtenLines = 0;
    let landedLines = 0;
    const ref = written.size > 0 ? await defaultRef(git, root) : "HEAD";
    for (const [path, hashes] of written) {
      writtenLines += hashes.size;
      const text = await git(root, ["show", `${ref}:${path}`]).catch(() => "");
      const present = new Set(lineHashes(text));
      for (const hash of hashes) if (present.has(hash)) landedLines++;
    }

    const usage = await store.usage.list({ sessionId: session.id });
    const cost = usage.reduce((total, row) => total + (row.cost ?? 0), 0);
    const answers = session.repoId
      ? await store.records.list({ spaces: [`repo:${session.repoId}`], type: "Memory", kind: "answer" })
      : [];
    const covered = steps.filter(
      (step) =>
        step.kind === "read" &&
        step.path &&
        answers.some(
          (answer) =>
            answer.createdAt < step.ts &&
            answer.anchors.some((anchor) => anchor.kind === "git" && anchor.ref === step.path),
        ),
    ).length;
    const rediscovery = steps.length > 0 ? (cost * covered) / steps.length : 0;

    const start = Math.floor(session.startedAt / 1000);
    const end = Math.floor((session.endedAt ?? summary.last) / 1000) + 3600;
    const log = await git(root, ["log", "--all", `--since=@${start}`, `--until=@${end}`, "--format=%s%n%b%n%D"]).catch(
      () => "",
    );
    const issueKeys = [...new Set(log.match(ISSUE) ?? [])].slice(0, 20);

    await store.outcomes.put({
      sessionId: session.id,
      writtenLines,
      landedLines,
      rediscovery,
      issueKeys,
      computedAt: now,
    });
    computed++;
  }
  return computed;
}

export interface Effectiveness {
  /** Spend of the sessions worked out, and what part of it turned into something that lasted. */
  spend: number;
  effective: number;
  /** Lines written and still on the default branch, over those written. */
  landedShare: number | null;
  rediscovery: number;
  perIssue: { key: string; cost: number; sessions: number }[];
  /** Sessions too recent to tell yet. */
  pending: number;
  sessions: number;
}

/** Spend weighted by each session's landed share; one that edited nothing earns credit when its records are used. */
export async function effectiveness(store: Store, since: number, now = Date.now()): Promise<Effectiveness> {
  const outcomes = new Map((await store.outcomes.list()).map((outcome) => [outcome.sessionId, outcome]));
  const costs = new Map<string, number>();
  for (const row of await store.usage.list({ since })) {
    costs.set(row.sessionId, (costs.get(row.sessionId) ?? 0) + (row.cost ?? 0));
  }
  const spaces = (await store.spaces.list()).map((space) => space.id);
  let spend = 0;
  let effective = 0;
  let written = 0;
  let landed = 0;
  let rediscovery = 0;
  let pending = 0;
  let sessions = 0;
  const issues = new Map<string, { cost: number; sessions: number }>();
  for (const [sessionId, cost] of costs) {
    const outcome = outcomes.get(sessionId);
    if (!outcome) {
      const session = await store.sessions.get(sessionId);
      if (session?.repoRoot && session.startedAt > now - LANDING_DAYS * DAY) pending++;
      continue;
    }
    sessions++;
    spend += cost;
    rediscovery += outcome.rediscovery;
    if (outcome.writtenLines > 0) {
      written += outcome.writtenLines;
      landed += outcome.landedLines;
      effective += cost * (outcome.landedLines / outcome.writtenLines);
    } else {
      const recorded = (await store.records.list({ spaces })).filter((record) => record.sessionId === sessionId);
      if (recorded.some((record) => record.hits > 0)) effective += cost;
    }
    for (const key of outcome.issueKeys) {
      const entry = issues.get(key) ?? { cost: 0, sessions: 0 };
      issues.set(key, { cost: entry.cost + cost / outcome.issueKeys.length, sessions: entry.sessions + 1 });
    }
  }
  return {
    spend,
    effective,
    landedShare: written > 0 ? landed / written : null,
    rediscovery,
    perIssue: [...issues].map(([key, entry]) => ({ key, ...entry })).sort((a, b) => b.cost - a.cost),
    pending,
    sessions,
  };
}
