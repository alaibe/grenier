# Personal data: notes, mail and calendar

Grenier can give AI tools access to your notes, mail and calendar, one tool at a time, with a log of every read.

## Add sources

```bash
grenier sources add markdown journal ~/Notes
grenier sources add ics work https://calendar.example.com/me.ics
grenier sources add caldav home https://caldav.example.com --user ada --password-command "security find-generic-password -s grenier-caldav -w"
grenier sources add imap mail imap.example.com --user ada@example.com --password-command "pass show mail/grenier"
grenier sources               # what each holds, and when it last synced
```

Passwords are never stored: Grenier runs your command (or reads `--password-env VAR`) each time it syncs. Markdown
folders are watched; mail and calendars are pulled every 5 minutes (`[sources] sync_interval`). Each pull reads only what
changed since the last one. Mail is read-only and goes back 90 days the first time (`--since-days`).

## Give a tool a scope

A tool reads personal data only with a client token, and only from the sources its scope names:

```bash
grenier mcp install claude-desktop --scope notes,calendar
grenier clients add my-script --scope journal
grenier clients               # who may read what
grenier clients revoke my-script
```

A scope lists source names (`journal`, `work`) or kinds: `notes`, `mail`, `calendar`, `memory`. A tool with no scope
gets the codebase tools only. Asking for an item outside its scope looks exactly like asking for one that does not
exist.

## What a tool can do

| Tool | Returns |
| --- | --- |
| `search` | Items matching a query, from the sources in scope |
| `get` | One item by its id |
| `timeline` | Dated items about a subject, oldest first, between two dates |
| `people` | Items and threads involving a person |
| `remember` | Nothing yet: it proposes a memory for you to approve |

Every item comes back with IBANs, phone numbers and street addresses removed, inside a block marked as untrusted data,
so instructions hidden in an email are read as text, not followed.

## The audit log

```bash
grenier audit                     # every read in the last 7 days
grenier audit --client claude-desktop --since 30d
```

Each read is written to the log, with the client, the tool, what it asked and the ids of what it got, before the answer
leaves. If the log cannot be written, the read fails.

## The review queue

`remember` never writes to your data. It adds a proposal:

```bash
grenier review                 # the proposals, as added lines
grenier review approve <id>    # becomes a memory, readable by tools with the memory scope
grenier review reject <id>
```

## Your other devices

Approved memories and source definitions can follow you to your other machines, end-to-end encrypted:

```bash
grenier vault init                # on the first device: prints the key to copy
grenier vault join gv1_…          # on each other device
grenier vault sync                # the daemon also syncs it with the team server
```

The key stays on your devices. The team server stores only what it encrypts, and cannot read it.
