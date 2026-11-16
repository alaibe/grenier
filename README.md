# Grenier

Grenier sits between AI tools and everything they read. It records what coding agents spend, stops runaway sessions,
and caches what they learn about a repository so the next session doesn't pay to learn it again. Later it shares that
cache across a team, and gives AI tools scoped, logged access to personal data.

It is at the very start: the scaffold is in place and nothing is usable yet. [PLAN.md](PLAN.md) is the plan.

## Development

Node 22 or later and pnpm (the version in `package.json`).

```bash
pnpm install
pnpm test
pnpm build && node apps/cli/dist/grenier.js status
```

`grenier status` creates `~/.grenier/` on first run. Set `GRENIER_HOME` to put it elsewhere.

## Licence

MIT
