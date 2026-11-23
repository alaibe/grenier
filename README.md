# Grenier

One store for what a team and its AI agents learn. Answers about the code, conventions, decisions, meetings, tasks
and docs are typed records, linked to each other and to the code they came from, and shared the moment they are
written. Agents read and write the store over MCP; people use the desktop app. Every machine keeps a full copy and
works offline.

The store runs in your team's own Cloudflare account, and there is no hosted service. Free and open source (MIT), for
macOS, Linux and Windows.

<p align="center">
  <a href="https://grenier.laibe.cc/promo/film-16x9.mp4"><img src="https://grenier.laibe.cc/promo/film.webp" width="800" alt="The promo film: four teammates' agents learning the same code, one team store that answers the second time, a shared skill, and a request run on an idle machine"></a>
</p>

**[Guide](https://grenier.laibe.cc/guide)** · [Download](https://grenier.laibe.cc/download) ·
[Security](https://grenier.laibe.cc/guide/security) · [Changelog](https://grenier.laibe.cc/changelog)

## What it does

- **One store.** Projects, tasks, meetings, decisions, docs, people and memories, each with the fields its type
  requires, linked to one another. Admins add types of their own. Records live in spaces: the team's, a repository's,
  a group's, and `me`, which only you can read.
- **Answers that expire on their own.** A memory about code keeps the git blob hash of every file it came from. Once
  one of them changes, it comes back stale with the files to re-read, and the editor shows what changed.
- **It asks before it shares.** When an agent wants to keep a decision or a fact, you see it first and choose: the
  team, `me`, or nothing. Answers about code are checked by their files instead.
- **Skills and MCP servers, once for everyone.** Share a skill or an MCP server's configuration with the team. Each
  machine installs it once its person approves it, and a change waits for approval again; what an admin recommends
  can install by itself. Credentials stay on each machine.
- **Routines on idle machines.** A routine is the team's recipe for one kind of task. File a request, and a teammate's
  machine that is idle, plugged in and allowed to takes it, runs it in a clean checkout, and attaches the result.
- **What it costs, and what it became.** Spending by person, machine, day and repository, for admins. On each
  machine, how much of what its agents wrote is still on the default branch two weeks later.

## How a team starts

```bash
npx wrangler login
grenier team deploy                 # the team store, in your Cloudflare account; you are its admin
grenier team invite marie           # a one-time link for Marie
grenier mcp install claude-code     # recall and remember, for your agents
```

Marie pastes the link into her app's Team screen, or runs `grenier team join <link>`. Her screen shows six digits,
she reads them to you, and you confirm them in the Team screen or with `grenier team confirm`. A team can have one person: the store
then follows you across your machines and repositories.

## The agent's tools

| Tool | What it does |
| --- | --- |
| `recall` | What the store holds for a question, best first, each marked as a hit or stale |
| `remember` | Keeps an answer, a summary, a convention, a decision, a meeting, any record, with the files it came from |
| `query` | Records by type, or one record with everything it links to |
| `request` | Files a task for one of the team's routines |
| `file_summary`, `repo_map` | Summaries of files and folders, while their content is unchanged |

Grenier's instructions tell the agent to recall before it explores and to remember after. With Claude Code,
`grenier mcp install claude-code --hook` also passes a close answer along with your prompt.

## Routines

A routine has prompt versions, a repository, the tools it may use, and an eval set. Each machine's person approves it
by its hash, in a mode:

| Mode | What a run may do |
| --- | --- |
| `read-only` | Read, and answer with what it found. Every routine starts here |
| `shadow` | Read, and list the actions it would take |
| `limited` | Act with its tools, a set number of times a day |
| `on` | Act with its tools |

With Claude Code, read-only is enforced twice: the agent is offered read tools only, and Grenier's proxy cuts off
any other call, an MCP tool's included, and stops the run. Codex runs in its own read-only sandbox. A run works in a
throwaway checkout of the machine's current commit, so a routine that changes code pushes its work with its tools,
as a branch or a pull request. A machine is available only while every rule its person set holds: on mains power, idle
for ten minutes, CPU and memory under their limits, inside its hours. When you come back, a run waits for you to
leave again, or goes to another machine.

Requests come from the app, from an agent's `request`, from a webhook, or on a schedule. A version reaches production
only once it scores at least as well on the evals as the one it replaces. Collectors are a person's own routines, run
on their own machines, that gather their meetings or tasks into `me`. The librarian looks through the store each day
and suggests fixes to stale, duplicated or broken records. A routine can also run as a GitHub Actions job on a
just-in-time runner from an idle teammate's machine, for private repositories only.

## Quick start

On a Mac, Homebrew installs the desktop app, with the daemon inside, and the `grenier` command. Open Grenier once from
Applications first: it isn't notarized yet, so macOS asks you to allow it.

```bash
brew install --cask alaibe/tap/grenier

grenier mcp install claude-code     # the store, for Claude Code; or cursor, codex, claude-desktop
grenier run -- claude               # an agent through the proxy, to see what it spends
grenier report                      # what it spent
```

On Linux, the `.deb` and the `.rpm` on the [download page](https://grenier.laibe.cc/download) install the app and the
command, as `/usr/bin/grenier`, and the Windows installer puts it on your PATH. With the DMG or the AppImage, the
command is built from source, with Node 22 or later and pnpm:

```bash
git clone https://github.com/alaibe/grenier.git
cd grenier
pnpm install
pnpm build
npm install --global ./apps/cli    # the grenier command, linked to this folder
```

## Benchmark

`bench/` asks the same questions about public repositories (Hono and Flask at pinned commits) twice through the real
proxy: once with nothing in the store (cold), then once after the cold run recorded its answer (warm). Measured on 16
November 2026 with Claude Code (`claude -p`) on Claude Opus 5.5, when `recall` and `remember` were still called
`ask_codebase` and `record_answer`:

| Repository | Question | Cold tokens | Cold cost | Warm tokens | Warm cost | Saved |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| hono | How does Hono match an incoming request to a route handler? | 738,621 | $0.9968 | 92,058 | $0.0682 | 93% |
| hono | How are middleware functions composed and run around a handler? | 521,375 | $0.4273 | 90,957 | $0.0568 | 87% |
| hono | Where is a JSON request body parsed, and what happens when it is invalid? | 467,540 | $0.3751 | 90,362 | $0.0466 | 88% |
| flask | How does Flask dispatch a request to a view function? | 405,517 | $0.3800 | 137,082 | $0.0770 | 80% |
| flask | How are the application and request contexts pushed and popped? | 391,527 | $0.4646 | 137,863 | $0.0813 | 83% |
| flask | How does the test client send a request without a server? | 352,294 | $0.3255 | 136,446 | $0.0679 | 79% |
| **Total** |  | 2,876,874 | $2.9693 | 684,768 | $0.3978 | 87% |

Tokens count input, prompt-cache writes and reads, and output, as the proxy recorded them; costs are at API prices
from `prices.toml`. Each question ran once each way. The full output is in
[`bench/results/2026-11-16.md`](bench/results/2026-11-16.md). To run it again, with a spending cap:

```bash
pnpm build && pnpm --filter @grenier/bench bench --budget 4
```

## Security

The daemon listens on 127.0.0.1 only. API keys pass through the proxy and are never stored. Nothing leaves your
machine until you deploy or join a team; then the team store, in your team's Cloudflare account, holds the records of
shared spaces, never file contents, prompts or keys. Your `me` records are encrypted with a key that stays on your
devices. Every read an MCP client makes is logged first, and what it reads comes back marked as untrusted data. The
desktop app sends anonymous usage statistics until you turn them off in its Settings: which screens you open, its
version and your system, nothing you write or read. The rules and how they are enforced are on the
[security page](https://grenier.laibe.cc/guide/security).

## Development

```bash
pnpm install
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
pnpm demo                           # the desktop app with made-up data, at http://localhost:1420
```

[AGENTS.md](AGENTS.md) is the guide for working in this repository.

This repository lives on git.laibe.cc, which runs its checks. The GitHub copy is a mirror.

## Licence

MIT
