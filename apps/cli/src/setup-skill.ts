/** The skill Grenier installs with its MCP server in Claude Code: a guided setup of the knowledge base. */
export const SETUP_SKILL = `---
name: grenier-setup
description: "Set up Grenier's knowledge base for this person and this repository: who they are, the repository's conventions, a map of its code, drafts of its decisions and design, and lean CLAUDE.md and AGENTS.md. Use when the person runs /grenier-setup, or asks to set up, organise or refresh what Grenier knows."
---
# Set up Grenier

Grenier keeps Markdown pages your agents read with \`get\` and write with \`set\` (mcp__grenier__get and mcp__grenier__set). This setup fills its folders from a short interview and the repository's own files, so the next agent finds what it needs instead of exploring.

The folders:
- Me/About: who the person is and how they like to work.
- Me/Notes: drafts and everything else.
- <repository>/Conventions: the repository's rules, one page per topic.
- <repository>: how its code works, each page with the files it came from.
- <repository>/Runbooks: how to deploy, release and handle an incident.
- Team/Conventions, Team/Decisions, Team/Design: what the whole team follows. Only the person moves pages there, in Grenier's Knowledge.

<repository> is the name of the repository's folder.

## How to work

- First, get the folders Me/About, <repository>/Conventions and <repository> with limit 200, to see what is already kept. On a run after the first, propose only what is new or changed, and the pages gone stale.
- Do the steps in order. Before each step's writes, show the person the pages you would write, each title with a line on what it says, and ask. Write only what they accept, as they edit it.
- A page holds one topic, in plain Markdown, short. Write only what the files or the person say; put a guess in a "To confirm" list at the end of the page instead.
- Every page about the code gets files: every file you read for it.
- Never write a key, a token, a password or personal data into a page.

## 1. About the person

Ask, a few at a time, and keep their own words:
- Their role, and what they work on most.
- How they like answers: short or detailed, which language.
- How they like to work: tests first or not, commit and branch style, what to ask before doing.
- Anything an agent should always or never do for them.

Set one page in Me/About, titled with their name.

## 2. The repository's conventions

Read the evidence, not opinions: CLAUDE.md and AGENTS.md, the README, the package or build files and their scripts, the linter, formatter and editor config, CI workflows, the test setup, and the last 50 commit messages.

Set one page per topic in <repository>/Conventions, each with the files it came from:
- Commands: install, build, test, lint, run, release.
- Code style: what the formatter and linter enforce, and what the code shows beyond them.
- Testing: where tests live, how they are named, what they must not touch.
- Git and review: branch names, commit messages, what a change must pass.
- Any other topic the files clearly show, such as dependencies, migrations or translations.

## 3. A map of the code

For each top-level folder of the code, and each folder one level down that holds a distinct part, read enough to say what it holds, where its main pieces are and what calls what.

Set one page per folder in <repository>, titled with the folder's path, two to six lines, with files set to the files you read. These turn stale when those files change, and the next get says so.

## 4. Decisions and design

Look for what the team decided and how it designs: architecture decision records, docs/, design tokens, component docs, a design system's README, and commit messages that state a choice ("use", "switch to", "drop", "instead of").

Set each as a draft in Me/Notes, titled "Decision: <what>" or "Design: <what>", with what was decided, why, when, and the files or commits it comes from. Tell the person the ones worth moving to Team/Decisions or Team/Design, in Knowledge.

If the repository deploys or releases, set what the files say about it in <repository>/Runbooks, one page each for deploy, release and incident.

## 5. CLAUDE.md and AGENTS.md

These load in every session, so they should hold only what must always be there. Propose, as a diff, keeping the rules that apply to every change and the commands, and replacing longer explanations now kept in Grenier with one line: "The rest is in Grenier: get <repository>/Conventions and ask before exploring." Edit the files only once the person says yes to the diff.

## At the end

Sum up what you wrote, folder by folder, the drafts waiting in Me/Notes, and what to confirm. Tell the person to run /grenier-setup again when the repository changes a lot.
`;
