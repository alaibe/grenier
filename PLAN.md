# Grenier

Grenier gives a team one store for its work and its agents, kept in the team's own Cloudflare account. There is no
hosted Grenier service: `grenier team deploy` puts a Worker, D1, R2 and Durable Objects in the team's account.

- **One team store.** Docs, decisions, tasks, meetings, projects, people, and what agents work out about the code:
  typed, linked records in the team's Worker, with a copy on every teammate's machine. Records anchored to code come
  back stale as soon as one of their files changes.
- **One team setup.** Skills and MCP servers one person sets up are installed into everyone's agent, so a newcomer
  starts with the team's setup on day one.
- **Shared work.** Anyone, or their agent, files a request; the Worker offers it to a named teammate machine that is
  idle and has room, without disturbing its person. Routines are versioned, tested against evals, and earn the right
  to act step by step. Collectors gather each person's meetings and tasks into the store from their own machine.
- **Visible cost.** A local proxy records what every model call costs, at the prices in `prices.toml`, and measures
  what that spend turned into. It sets no limits. Each person sees their own cost; the team's admins see everyone's.

Each person runs the Grenier daemon and its desktop app. Their agent (Claude Code, Codex, Cursor) connects to the
daemon over MCP and reaches GitHub, Linear, Slack and the rest through its own MCP servers. Grenier itself stores,
records and measures; it never writes to a team's tools or edits code. Routines are agents it starts and guards.

A team can be one person: their laptop and desktop share the `me` space, and every project keeps its own records,
reachable from any of their machines.

## The team store

The Worker holds the store and puts every change in order. Each machine keeps a copy of the spaces its person belongs
to, works from it offline, and catches up from its last change when it reconnects. A space is `me` (the person's own
devices), `repo:<id>`, `team`, or one the team makes.

- **Repos.** Each repo has its own space, for everything about that codebase: its architecture, how to set it up and
  run it, its conventions, owners, decisions, and the answers and summaries agents work out about its code. The space
  also keeps the repo's name and default branch; never its code. The same repo can sit in different folders, under
  different remote URLs, on each machine; its first commit is the same in every clone, so that commit's hash is the
  repo's id, and every clone shares one space.
- **Projects** link several repos: `recall` in `web` also finds what was recorded in `api` when both belong to the
  Checkout project, then searches `team` and `me`.

- **Records.** Each has a type, fields, links and a space. The core types are Project, Task, Meeting, Decision, Doc,
  Person and Memory (an answer, summary, convention or fact). Admins can add types with their own fields.
- **Links** make the store navigable: asking for the Q4 plan returns its meetings, decisions, tasks and docs in one
  step, without a search through everything.
- **What goes in.** Only what a person or an approved routine puts in, plus webhooks an admin sets up. Nothing is
  synced in from other tools on its own; agents read those through their own connectors and file what is worth
  keeping. Records are text; recordings and large files stay out.
- **Meetings.** A person or their agent files a transcript from their recorder as a Meeting, linked to its project and
  people. A summary memory is made from it.
- **Anchors** say what a record came from: a file with its git blob hash, or an outside item with a ref that is the
  same on every machine (`linear:acme/LIN-123`) and the version the agent saw. On a read, a record is `hit` when every
  git anchor still matches, `stale` with the changed files when one does not, and `unchecked` when it has item
  anchors, which the agent re-checks with its own tools.
- **Rules per type.** Required fields, allowed values and links, checked on every write: a Decision needs an owner, a
  date and a reason. Every write also refuses keys, and a memory more than a short code snippet.
- **Asking first.** Before an agent writes, edits or retires a record, Grenier shows the person the record and its
  space through MCP elicitation: share, edit, keep it in `me`, or cancel. A client that cannot ask gets the record
  kept in `me`. Answers and summaries anchored only to code are recorded without asking.
- **Sharing.** Teammates trust each other by default: once written, a record reaches its space at once. Anyone in the
  space can edit or retire it afterwards; every edit is kept in the record's history, with who made it.
- **Untrusted.** A teammate's record reaches an agent scoped, audited, redacted and marked as untrusted data, since a
  shared store is a path for prompt injection.
- **Search.** The Worker indexes the store (full text and vectors), so search works across the team, in the web view
  and for agents; each machine also searches its own copy offline.
- **Tools.** `recall` searches every record; the agent asks it before exploring code or looking anything up, and skips
  the work on a `hit`. `query` reads records by type and fields and follows their links. `remember` writes a record.
  `request` files a task for a routine. `file_summary` and `repo_map` give an overview of a repository.

## Team on Cloudflare

- **Who can read.** The Worker reads the store, to order, index and serve it. Anyone with access to the team's
  Cloudflare account can read it too; the guide says so plainly. The `me` space is the exception: it is end-to-end
  encrypted with the person's own key, and the Worker stores it without being able to read it.
- **Sync.** Grenier's own small log, no sync library. A Durable Object per team gives every change a sequence number,
  applies it to the D1 tables that search indexes, and pushes it to connected machines over a WebSocket. Offline, a
  machine queues its changes, each with an id so a resend applies once, and on reconnect sends them and pulls
  everything after the last sequence number it has. The latest write wins, field by field, in the server's order. The
  `me` space travels the same path as encrypted blobs.
- **Access.** Every call carries a member token, one per device, stored hashed; a revoked token fails on its next call.
  The Worker serves a record only to members of its space.
- **Admins.** An admin can make another member admin, or take it back, and can add or remove members and spaces. The
  Worker refuses any change that would leave the team without an admin.
- **Joining.** An admin shares a one-time invite link, valid for 24 hours. When the new device opens it, both screens
  show the same six-digit code, and the admin confirms it before the device gets its token. A leaked link alone gets
  nobody in.
- **Machines.** Each device has a name, chosen when it joins and editable (`anthony-mbp`, `build-mini`). Everyone in
  the team sees each machine's name, person, state (offline, busy, available) and the routines it ran.
- **Usage.** Each machine sends its usage by day and repo: tokens, cost, sessions, routine runs, and the hours it gave
  to the team's routines. The Worker shows each person their own machines' usage, and admins every machine's.
- **Web view.** The Worker serves the store, requests and routines to members in a browser, phones included.
- **Remote MCP.** Agents that do not run on a teammate's machine (Claude on the web, cloud agents) reach the store
  through the Worker's MCP endpoint with a member token, under the same scopes.

## Skills and MCP servers

A skill (`SKILL.md` and its files) or an MCP server's configuration (command or URL, pinned version, never
credentials) is shared in a space, from the desktop app, `grenier skills share <folder>` or `grenier mcp share <name>`.

- **The team list.** The desktop app lists what the team shares. Anyone installs an item with a click, after seeing
  its files or configuration: that click approves its hash. A change waits for approval again; retiring an item
  removes it everywhere.
- **Recommended.** Admins mark what every teammate should have. Each person can turn on "install recommended items
  automatically", offered when they join: recommended items and their updates then install without asking, each with
  a notification showing what changed and a way back to the previous version.
- Skills and local MCP servers run code on the machine, so outside the recommended set nothing installs without its
  machine's user approving its hash.
- Grenier installs a skill where the agent looks for skills (for Claude Code, `~/.claude/skills/`) and an MCP server
  into the agent's MCP configuration, under a `grenier-` prefix so it never overwrites the person's own. An MCP
  server's credentials are asked of each person and kept the way they choose; they never leave the machine.

## Routines

A routine is a shared record: prompt versions, repo, allowed tools, mode, and an eval set. A routine is the team's
factory for one kind of task.

- **Requests.** A Task names a routine and moves through to-do, doing and done. Anyone files one, from the app, the web
  view or their agent's `request`. The Worker offers it to one available machine (see Machines); the machine accepts
  or declines, and the Worker offers it to the next one. A machine that goes quiet mid-run loses the task to another.
  Each task runs on exactly one machine, and the result is attached to it.
- **Outside requests.** An admin can point a webhook from Linear, Slack, email or a form at the Worker, for one
  routine; each event becomes a request.
- **GitHub.** A routine can also start from a GitHub schedule or event. Its workflow file
  (`runs-on: [self-hosted, grenier]`, one step: `grenier routines exec <name>`) is printed by Grenier and committed by
  a person. While a machine is available and the repo has a queued job, Grenier registers a just-in-time runner for
  one job, from a runner binary pinned by SHA-256; never for a public repository. A runner hook fails any job whose
  workflow is not the approved one.
- **Machines.** `grenier routines on` opts a machine in. Each machine's user approves each routine by hash; a change
  waits for their approval again. A run uses the machine user's own credentials, in a clean checkout.
- **Not disturbing anyone.** An opted-in machine checks its rules locally and tells the Worker only when its state
  changes (available, busy, away) and how much room it has, over the connection it already keeps open for sync. It
  is available only when every rule its user set holds: on mains power, no keyboard or mouse for ten minutes, CPU
  and memory under their thresholds, inside its hours (nights only, for example), and no run already going. The
  Worker offers work to the machine with the most room that has the routine's repo and agent. A run goes at the
  lowest system priority; when the person comes back, the proxy holds its next model call until the machine is idle
  again, or hands the task to another machine after a set time. An always-on machine sets its rules to always.
- **Collectors.** A person's own routines, run only on their own machines on a schedule, to gather what their agent
  can reach: today's meeting transcripts, their open tasks, their pull requests. Each collector writes its records to
  `me`, or to the spaces its person chose when setting it up, and runs read-only like any routine.
- **Modes.** A routine starts read-only, enforced twice: the agent starts with read tools only (Claude Code's
  allowlist, Codex's read-only sandbox; other agents are refused), and the proxy cuts off any other tool call
  mid-stream. To act, it moves up on each machine whose user allows it: `shadow` records what it would have done,
  `limited` takes a set number of actions a day, `on` acts freely within its allowed tools. Every action is in the run
  history.
- **Versions and evals.** Each prompt version is `testing`, `production` or `retired`; a request can name a testing
  version. The eval set lists test tasks and what a good result looks like, judged by code, by a model or by a person.
  A version reaches production only when it scores at least as well as the one it replaces. A thumbs up or down on a
  real run adds it to the eval set.
- **The librarian.** A built-in routine keeps the store healthy: stale and unchecked records, duplicates,
  contradictions, missing links, records that break their type's rules. It suggests edits; a person accepts them.
- A routine's output is written to its space without asking, since nobody watches a run: the approved routine stands
  in for the person.

## Effectiveness

Worked out on each machine. A person's numbers never leave it; the team's routine numbers are in the store.

- **Landed share:** how much of what a session wrote is on the default branch 14 days later, checked by line hashes.
- **Effectiveness ratio:** spend weighted by landed share. Sessions with no edits earn credit for the hits on what
  they recorded.
- **Rediscovery:** spend on reading what a cached answer already covered.
- **Cost per issue:** spend by issue key, found in branch names and commit messages.
- **Routine quality:** eval scores per version, thumbs on real runs, cost per request.

The proxy also traces where each session went in the code, and its loop guards notify or pause a session that repeats
the same tool call.

## Knowledge editor

People write and fix the store themselves, in the desktop app and the web view, not only through agents.

- **Records.** Each type opens as a form for its fields, with its type's rules checked as you type, and a Markdown body
  for Docs, Meetings and Memories. A new record starts from a type, or from a template an admin made for it.
- **Links.** Typing `@` links a person, project, repo or any record; `/` creates a linked record in place, such as a
  Task from a line of meeting notes. Each record lists what links to it.
- **Anchors** show beside the record with their state (`hit`, `stale`, `unchecked`); a stale one opens the changed
  files' diff.
- **History.** Every version, who made it and from which machine or agent, with a diff and a way to restore it.
- **Editing together.** The editor shows who else has a record open. If two people change the same field, the second
  save sees the first one's change and chooses which to keep, so nothing is lost silently.

## Desktop app

Dashboard; the store and its editor, with table, board and calendar views per type; requests; routines, with
versions, evals and runs; collectors; skills and MCP servers; team and machines, with their rules and usage;
effectiveness; traces; clients and the audit log.

## Guarantees

1. The daemon's proxy, MCP and admin endpoints listen on `127.0.0.1` only; the daemon talks to nothing but the team's
   Worker, the model providers and, for routines, GitHub. The Worker needs a member token on every route except a
   webhook's own secret URL.
2. Model API keys and tool credentials are forwarded or used locally, never stored, logged or sent to the Worker.
3. The team store lives only in the team's own Cloudflare account. Only what a person, an approved routine or an
   admin's webhook put into a space goes there, after the checks for keys and code; nothing an agent's tools returned
   goes out on its own.
4. The `me` space is end-to-end encrypted; its key never leaves the person's devices.
5. The Worker serves a record only to members of its space, and keeps the team with at least one admin.
6. Grenier never writes to a tool or edits code. A routine acts only through the tools its machine's user allowed, in
   the mode they chose, and every action is logged.
7. Skills and MCP servers install only once their machine's user approved their hash, or turned on automatic install
   of what admins recommend.
8. A person's effectiveness numbers stay on their machine; their machines' usage and cost reach only them and the
   team's admins.
9. The desktop app sends anonymous screen views until turned off in its Settings; the CLI, the daemon and the Worker
   send none.
