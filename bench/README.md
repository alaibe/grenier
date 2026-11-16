# Benchmark

Runs the questions in `repos.json` on each pinned public repository twice, through the real proxy and an agent: once
with Grenier's cache empty (cold), once with what the cold run recorded (warm). It writes tokens and cost for both
runs to `results/<date>.md`. Only numbers this benchmark measured go in the README.

It calls a real model with your own credentials, so it is run by hand, never in CI:

```bash
pnpm build
ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @grenier/bench bench
```

It keeps everything under `bench/.work` (clones, and a Grenier home of its own on port 7789), so your own
`~/.grenier` and daemon are left alone. The agent is Claude Code (`claude -p`) with only Grenier's MCP server and the
read-only tools; `--agent <command>` runs another one, with `{question}` and `{mcp}` (the MCP config file) in its
arguments.
