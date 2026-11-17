# Teams

A team shares its exploration cache, its budgets and a dashboard through a server it deploys to its own Cloudflare
account. There is no hosted Grenier service.

## Deploy

Turn on R2 in the Cloudflare dashboard first, once per account: the encrypted vault is kept there, and R2's free tier
is enough. Then:

```bash
npx wrangler login
grenier team deploy
```

This creates a D1 database and an R2 bucket, applies the migrations, deploys the Worker, makes this machine the team's
admin and joins it. The admin token is printed once and saved in `~/.grenier/team-token`.

## Invite and join

```bash
grenier team invite marie                       # prints the command to send Marie
grenier team join https://grenier-team.<you>.workers.dev gt_…    # on Marie's machine
```

## Share a repository

Nothing is shared until you say so, repository by repository:

```bash
grenier team share              # the repository you are in
grenier team share --repo ../api
grenier team unshare
```

`[cache] share_with_team = true` shares every repository instead. The daemon then syncs every 20 seconds
(`[team] sync_interval`): answers and summaries of shared repositories go up, what teammates recorded comes down. An
answer recorded on one machine is a hit on another within one sync. While the server cannot be reached, each machine
carries on with its own cache.

The server stores answers, summaries and usage numbers per member and day. It never sees file contents, prompts or API
keys.

## Team budgets

```bash
grenier team budget --team 50 --member 10    # admins only; "off" removes one
grenier team budget                          # today's spending against the limits
```

Days are UTC. Each machine checks them before forwarding a request (asking the server at most every 15 seconds); when
the server cannot be reached, requests go through.

## The dashboard

Open the team server's address in a browser and paste an admin token. It shows the day's and the month's spending,
savings from the prompt cache, answers reused and shared, usage per member and day, and the members, with a Revoke
button: a revoked token is refused at its next call.
