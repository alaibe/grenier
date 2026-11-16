# Benchmark

Runs the questions in `repos.json` on each pinned public repository twice, through the real proxy and an agent: once
without its answer in Grenier's cache (cold), then once with what the cold run recorded (warm), one question after
the other. It writes tokens and cost for both
runs to `results/<date>.md`. Only numbers this benchmark measured go in the README.

It calls a real model with your own credentials (an API key, or the Claude Code you are signed in to), so it is run
by hand, never in CI. `--budget` caps what it may spend, in dollars at API prices: Grenier's own budget stops the agent
when it is reached, and a question whose runs did not both finish is listed under the table, not counted in it.

```bash
pnpm build
pnpm --filter @grenier/bench bench --budget 4
```

It keeps everything under `bench/.work` (clones, and a Grenier home of its own on port 7789), so your own
`~/.grenier` and daemon are left alone. The agent is Claude Code (`claude -p`) with only Grenier's MCP server and the
read-only tools; `--agent <command>` runs another one, with `{question}` and `{mcp}` (the MCP config file) in its
arguments.
