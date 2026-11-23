import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "@grenier/core";
import type { Store } from "@grenier/store";

/** GitHub's runner, pinned by version and by the SHA-256 of each platform's archive, from its release notes. */
export const RUNNER_VERSION = "2.338.2";
export const RUNNER_SHA256: Readonly<Record<string, string>> = {
  "osx-arm64": "25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388",
  "osx-x64": "109fff505a34014a7e8d1acb850c33d404811102f572b8fb9788e2fff013cc49",
  "linux-x64": "baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40",
  "linux-arm64": "670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945",
  "win-x64": "a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc",
};

/** actions/checkout v7.0.1, by its commit. */
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
export const LABELS = ["self-hosted", "grenier"] as const;

export function runnerPlatform(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "darwin" ? "osx" : platform === "linux" ? "linux" : platform === "win32" ? "win" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  const name = os && cpu ? `${os}-${cpu}` : null;
  return name && RUNNER_SHA256[name] ? name : null;
}

/** owner/repo of a GitHub remote, as git stores it over SSH or HTTPS. */
export function githubRepo(remote: string): { owner: string; repo: string } | null {
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match ? { owner: match[1] as string, repo: match[2] as string } : null;
}

/** The workflow file a routine runs from on GitHub: committed as printed, since the runner refuses any other. */
export function workflowYaml(routine: { id: string; title: string; fields: Record<string, unknown> }): string {
  const cron = typeof routine.fields.schedule === "string" && routine.fields.schedule.trim().split(/\s+/).length === 5;
  return [
    `# Grenier's routine "${routine.title}" (${routine.id}).`,
    "# Commit it as it is: a Grenier runner refuses a job whose workflow differs from the one approved on it.",
    `name: ${JSON.stringify(routine.title)}`,
    "on:",
    "  workflow_dispatch: {}",
    ...(cron ? ["  schedule:", `    - cron: ${JSON.stringify(String(routine.fields.schedule).trim())}`] : []),
    "permissions:",
    "  contents: read",
    "jobs:",
    "  run:",
    `    runs-on: [${LABELS.join(", ")}]`,
    "    timeout-minutes: 60",
    "    steps:",
    `      - uses: ${CHECKOUT}`,
    `      - run: '"$GRENIER_BIN" routines exec ${routine.id}'`,
    "",
  ].join("\n");
}

export async function workflowHash(text: string): Promise<string> {
  return sha256(text.replace(/\r\n?/g, "\n"));
}

/** GitHub's REST API with the person's own token. */
export interface GitHub {
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

export function gitHub(token: string, fetchImpl: typeof fetch = fetch): GitHub {
  return {
    async api<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${path}`);
      return (await response.json()) as T;
    },
  };
}

/** The person's own GitHub token, from the gh command they signed in with; null without one. */
export async function ghToken(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 5000, encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Whether a private repository has a job waiting for a Grenier runner. Never true for a public one. */
export async function waitingJob(github: GitHub, owner: string, repo: string): Promise<boolean> {
  const about = await github.api<{ private?: boolean }>(`/repos/${owner}/${repo}`);
  if (about.private !== true) return false;
  const runs = await github.api<{ workflow_runs: { id: number }[] }>(
    `/repos/${owner}/${repo}/actions/runs?status=queued&per_page=20`,
  );
  for (const run of runs.workflow_runs) {
    const jobs = await github.api<{ jobs: { status: string; labels: string[] }[] }>(
      `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=latest`,
    );
    if (jobs.jobs.some((job) => job.status === "queued" && LABELS.every((label) => job.labels.includes(label)))) {
      return true;
    }
  }
  return false;
}

/** A runner registration for one job: it removes itself from the repository once the job is done. */
export async function jitConfig(github: GitHub, owner: string, repo: string, name: string): Promise<string> {
  const answer = await github.api<{ encoded_jit_config: string }>(
    `/repos/${owner}/${repo}/actions/runners/generate-jitconfig`,
    { body: { name, runner_group_id: 1, labels: [...LABELS], work_folder: "_work" } },
  );
  return answer.encoded_jit_config;
}

/** The pinned runner, downloaded once into ~/.grenier/runner and checked against its SHA-256 before it is unpacked. */
export async function ensureRunner(home: string, platform: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const dir = join(home, "runner", RUNNER_VERSION);
  if (existsSync(join(dir, platform.startsWith("win") ? "run.cmd" : "run.sh"))) return dir;
  const extension = platform.startsWith("win") ? "zip" : "tar.gz";
  const file = `actions-runner-${platform}-${RUNNER_VERSION}.${extension}`;
  const response = await fetchImpl(`https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${file}`);
  if (!response.ok) throw new Error(`could not download GitHub's runner: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== RUNNER_SHA256[platform])
    throw new Error(`GitHub's runner does not match its pinned SHA-256 (${digest})`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, file);
  writeFileSync(archive, bytes);
  await promisify(execFile)("tar", ["-xf", archive, "-C", dir]);
  rmSync(archive);
  return dir;
}

/**
 * The job-started hook: the runner calls it before each job, and a job whose workflow is not the one approved on
 * this machine fails there.
 */
export function writeHook(dir: string, self: readonly string[]): { hook: string; bin: string } {
  const quoted = self.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
  const hook = join(dir, "grenier-hook.sh");
  writeFileSync(hook, `#!/bin/sh\nexec ${quoted} routines hook\n`);
  chmodSync(hook, 0o755);
  const bin = join(dir, "grenier");
  writeFileSync(bin, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  chmodSync(bin, 0o755);
  return { hook, bin };
}

/** Runs the runner for its one job; resolves with its exit code once it is done. */
export function runJob(
  dir: string,
  config: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const script = existsSync(join(dir, "run.sh")) ? join(dir, "run.sh") : join(dir, "run.cmd");
    const child = spawn(script, ["--jitconfig", config], { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => log(`grenier: GitHub runner: ${chunk.toString().trim()}`));
    child.once("error", () => resolve(127));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** Approves a workflow's text for a routine on this machine. */
export async function approveWorkflow(store: Store, routineId: string, text: string): Promise<string> {
  const hash = await workflowHash(text);
  await store.approvals.put({
    recordId: routineId,
    kind: "workflow",
    hash,
    approvedAt: Date.now(),
    settings: {},
    installedPath: null,
    previousHash: null,
  });
  return hash;
}

/**
 * The hook's check, from the variables GitHub sets for the job: the workflow file at the job's commit, hashed and
 * compared with the approved ones. Returns why it is refused, or null.
 */
export async function checkWorkflow(store: Store, github: GitHub, env: NodeJS.ProcessEnv): Promise<string | null> {
  const ref = env.GITHUB_WORKFLOW_REF ?? "";
  const sha = env.GITHUB_WORKFLOW_SHA ?? env.GITHUB_SHA ?? "";
  const match = /^([\w.-]+)\/([\w.-]+)\/(.+?)@/.exec(ref);
  if (!match || !sha) return "the job does not say which workflow it runs";
  const file = await github.api<{ content: string; encoding: string }>(
    `/repos/${match[1]}/${match[2]}/contents/${match[3]}?ref=${encodeURIComponent(sha)}`,
  );
  const text = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  const hash = await workflowHash(text);
  const approved = (await store.approvals.list("workflow")).some((approval) => approval.hash === hash);
  return approved ? null : `${match[3]} is not a workflow approved on this machine (grenier routines workflow)`;
}
