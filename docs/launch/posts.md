# Launch posts (drafts)

Post only after the benchmark has run with a real model and its table is in the README, the name is settled (PLAN.md,
Open decisions), and the repository is public on GitHub. Replace every `<…>` with a measured figure or a real link;
publish nothing with a placeholder left in it.

## Show HN

**Title:** Show HN: Grenier – a local proxy that caches what coding agents learn about your repo

**Text:**

I kept watching Claude Code re-read the same twenty files at the start of every session to work out how our codebase
fits together, and paying for it each time. Grenier is a local daemon that sits between the agent and the API.

It does three things for coding agents:

- Records every model call (tokens, prompt-cache reads and writes, cost) by session and repository, and enforces
  daily, per-session and per-repo budgets before a request leaves the machine. The agent gets an error it does not
  retry.
- Detects tool-call loops (the same call three times in ten) and notifies you or pauses the session.
- Keeps an exploration cache over MCP: the agent asks `ask_codebase` before exploring and calls `record_answer` after,
  with the files it read. The answer is reused until one of those files' git blob hashes changes; then it comes back
  stale with the paths to re-read. Questions are matched by meaning with a 30 MB local embedding model.

On public repositories, the same questions cost <measured> cold and <measured> warm (`bench/`, table in the README).

A team can deploy a server to its own Cloudflare account with one command to share the cache and budgets. There is
also an opt-in side for personal data: notes, mail and calendars over MCP with per-tool scopes, an audit log of every
read, redaction, and AI-proposed memories that wait for your approval.

MIT, TypeScript, SQLite. No hosted service. <link>

## Product Hunt

**Tagline:** Your AI agents stop paying to relearn your codebase

**Description:** Grenier is a free, open-source daemon between your AI tools and everything they read. It records and
caps what coding agents spend, keeps what they work out about your code until the files change, shares it with your
team through a server in your own Cloudflare account, and gives AI tools scoped, audited access to your notes, mail and
calendar.

**First comment:** Why we built it, the benchmark table with its method (`bench/`), what stays on your machine, and the
plan for what comes next.
