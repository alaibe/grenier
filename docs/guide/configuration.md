# Configuration

Grenier reads `~/.grenier/config.toml` (or `GRENIER_CONFIG`). Every key is optional; a missing file means every
default. An unknown key, or a value of the wrong kind, stops Grenier with a message naming it.

```toml
[proxy]
port = 7788                                   # where the daemon listens, on 127.0.0.1
upstream_anthropic = "https://api.anthropic.com"
upstream_openai = "https://api.openai.com"    # for requests under /openai/: OpenAI or any compatible API
inject_cache_control = false                  # add automatic prompt caching to requests that set none (logged)

[budgets]                                     # in dollars; `grenier budget set` wins over these
daily = 10
session = 3

[guards]
loop_repeat_threshold = 3                     # the same tool call this many times…
loop_window = 10                              # …in the last this many calls is a loop
on_loop = "notify"                            # or "pause"
pause_timeout = 600                           # seconds a paused session's request waits for `grenier resume`

[cache]
embeddings = "local"                          # or "off": full-text matching only
share_with_team = false                       # share every repository, not only those `grenier team share` names

[team]
url = ""                                      # set by `grenier team join` or `team deploy`
token_env = "GRENIER_TEAM_TOKEN"              # an env var holding the member token, read before ~/.grenier/team-token
sync_interval = 20                            # seconds between two syncs with the team server

[sources]
sync_interval = 300                           # seconds between two pulls of mail and calendars

[prices."claude-opus-5-5"]                    # override or add a model's prices, USD per million tokens
input = 4.0
output = 20.0
cache_write_5m = 5.0
cache_write_1h = 8.0
cache_read = 0.2
fast = 2.0                                    # multiplier for responses served in fast mode
```

`upstream_anthropic`, `upstream_openai` and `team.url` must use https, except for 127.0.0.1, localhost and [::1].

## Paths

| Variable | Default | Holds |
| --- | --- | --- |
| `GRENIER_HOME` | `~/.grenier` | everything below, unless moved |
| `GRENIER_CONFIG` | `<home>/config.toml` | this file |
| `GRENIER_DB` | `<home>/grenier.db` | usage, the cache, personal data, the audit log |

Also in the home directory, readable by your user only: `admin-token` (the desktop app's key to the daemon),
`team-token`, `vault.key`, `daemon.pid`, `daemon.log`, and `models/` (the embedding model).
