# Demo video script

About three minutes. One terminal on the left with Claude Code, Grenier's desktop app on the right showing the
dashboard. The token counter is `grenier report --by session`, refreshed after each run. Record against a public
repository (Hono at `73ff6c0`, as the benchmark uses) with a fresh `GRENIER_HOME`, so the cache starts empty.

Use only numbers the recording shows; never a figure from elsewhere.

## 1. The problem (0:00–0:20)

On screen: Claude Code answering "How does Hono match an incoming request to a route handler?", reading file after
file.

Voice: "Every new session starts from zero. The agent reads the same files again to rediscover how the code fits
together, and you pay for every token of it."

## 2. Through Grenier, cold (0:20–1:00)

```bash
grenier mcp install claude-code
grenier run -- claude -p "How does Hono match an incoming request to a route handler?"
grenier report --by session
```

On screen: the agent calls `ask_codebase` (miss), explores, answers, then calls `record_answer` with the files it read.
The report shows the session's input tokens and cost.

Voice: "Same agent, same question, run through Grenier. Nothing changes for the agent, except that when it has worked
the answer out, it keeps it, with the exact version of every file it read."

## 3. Warm (1:00–1:40)

A new session, and the question in other words:

```bash
grenier run -- claude -p "Where does Hono decide which handler serves a request?"
grenier report --by session
```

On screen: `ask_codebase` returns a hit; the agent answers without exploring. Put the two report lines side by side.

Voice: "A new session, worded differently. Grenier recognises the question, checks that none of the files changed, and
hands the answer back. Here is what that saved." Read the two numbers from the screen.

## 4. When code changes (1:40–2:10)

Edit one of the cited files, ask again.

On screen: `ask_codebase` returns `stale` with the changed file; the agent re-reads only that file and records again.

Voice: "Answers are tied to file contents, not timestamps. Change a file and the answer says so, and which file to
re-read."

## 5. Guards (2:10–2:40)

```bash
grenier budget set --session 0.01
grenier run -- claude -p "Refactor the router"
```

On screen: Claude Code stops with Grenier's message naming the limit and the command to raise it, and does not retry.

Voice: "Budgets are checked before a request leaves your machine. The agent stops cleanly and tells you why."

## 6. Close (2:40–3:00)

On screen: the desktop app's dashboard, then the team dashboard.

Voice: "Grenier is free and open source, runs on your machine, and the team server runs in your own Cloudflare
account. Link below."
