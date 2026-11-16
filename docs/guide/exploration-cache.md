# The exploration cache

Agents spend much of their tokens reading code to work out how something fits together, and the next session reads the
same files again. Grenier keeps what they worked out, keyed by the content of the files it came from.

## The tools

| Tool | Does |
| --- | --- |
| `ask_codebase` | The answer recorded for this question or one close to it: `hit` while its files are unchanged, `stale` with the files changed since, or `miss` |
| `record_answer` | Keeps an answer with the git blob hash of every file it was worked out from |
| `file_summary` | The summary recorded for a file or directory, if its content is unchanged |
| `record_summary` | Keeps a short summary of a file or directory as it is now |
| `repo_map` | The repository's top-level modules with their summaries |

Answers are matched by meaning as well as by words: a local embedding model (Model2Vec `potion-base-8M`, 30 MB,
downloaded once and checked against its pinned hash) finds a question asked in other words. `[cache] embeddings =
"off"` keeps matching to full text.

## When an answer goes stale

Each answer stores the blob hash of every file it cites, taken from git (`git hash-object`, so unstaged edits count).
`ask_codebase` compares them with the files as they are now. Edit or delete one and the answer comes back `stale`, with
the paths to re-read; record the answer again and it is a hit once more.

A repository is identified by its first commit, so every clone, on any machine, shares one cache.

## What is kept

Answers and summaries hold text an agent wrote, never file contents: a summary over 4,000 characters, or quoting more
than 10 lines of code at once, is refused. `grenier cache clear [--repo <name or path>]` empties the cache.
