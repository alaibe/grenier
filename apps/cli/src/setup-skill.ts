/** The skill Grenier installs with its MCP server in Claude Code: a guided setup of the knowledge base. */
export const SETUP_SKILL = `---
name: grenier-setup
description: "Set up Grenier's knowledge base for this person and their repositories, this one or every one beside it: who they are, the conventions shared by each kind of project, the plans they have decided, and runbooks. Use when the person runs /grenier-setup, or asks to set up, organise or refresh what Grenier knows."
---
# Set up Grenier

Grenier keeps Markdown pages your agents read with \`get\` and write with \`set\` (mcp__grenier__get and mcp__grenier__set). This setup fills it from a short interview and the repositories' own files.

Keep only what an agent can't find by reading one repository: the person, what holds across their projects, the plans and how to ship. Never map or describe the code, and never copy a repository's own rules: those stay in its CLAUDE.md or AGENTS.md.

The folders:
- Me/About: who the person is and how they like to work.
- Me/Notes: drafts and everything else.
- Me/<repository>: what agents work out about its code as they go. The setup writes nothing there.
- Team/Conventions, Team/Decisions: what the whole team follows and plans.
- Team/<repository>/Runbooks: how to deploy, release and handle an incident.

Everything is a path in Me or Team. You write only in Me; the person moves a page to Team, in Grenier's Knowledge.

<repository> is the name of the repository's folder.

## How to work

- If \`get\` and \`set\` are deferred, load both with ToolSearch first.
- Ask the scope first: this repository only, or every repository in its parent folder. List the ones you found (each folder with a \`.git\`) with what each is built with, from its build files.
- For a repository other than the one you run in, pass its path as \`repo\` to \`get\` and \`set\`.
- Get Me/About, Me/Notes, Team/Conventions and, for each repository in scope, Team/<repository>/Runbooks, with limit 200, to see what is already kept. On a run after the first, propose only what is new or changed, and re-read the files a stale page lists.
- Ask once how to go: show the pages of each step and wait for a yes, or run the steps through and sum up at the end. Then work that way.
- When showing a step, show all its pages at once, one line each: its title and what it holds. Write what the person accepts, as they edit it.
- Across several repositories, hand the reading of each repository's files to one subagent per repository or small group, in parallel, each told these rules and its repository's path.
- Keep it small. A page holds one topic in at most ten short lines: one fact a line, no restating another page. Write only what the files or the person say; put a guess in a "To confirm" list at the end of the page instead.
- Keep what you tell the person small too: counts per folder and what needs them, not lists of every page.
- Every page drawn from files gets files: every file you read for it.
- Never read a \`.env\` file or a script that holds secrets, and never write a key, a token, a password, an address or personal data into a page.

## 1. About the person

Ask, a few at a time, and keep their own words:
- Their role, and what they work on most.
- How they like answers: short or detailed, which language.
- How they like to work: tests first or not, commit and branch style, what to ask before doing.
- How much an agent should do on its own, and anything it should always or never do for them.
- Principles they apply to every project. Keep them as they give them, translated to the language they want pages in.

Set one page in Me/About, titled with their name. Set their principles as a draft in Me/Notes, "Engineering principles", for Team/Conventions.

## 2. Conventions by kind of project

Read each repository's CLAUDE.md and AGENTS.md, README, build files, linter and formatter config, and CI workflows, to find what several repositories share.

Set drafts in Me/Notes for Team/Conventions: "Conventions: all projects" for what every repository shares, then one page per kind (for instance desktop apps, mobile apps, web apps, games), each naming its stack and languages, the rules its repositories share and the repositories it covers. A rule only one repository has stays in its own CLAUDE.md or AGENTS.md. Ask which kinds the person's projects fall into and which stack each uses, when the files leave it unclear.

## 3. Plans and runbooks

A decision is what the person plans to do, not what the code already shows: never draw decisions from the code, docs or commits. Ask what they have decided to do next, and why. Set each as a draft in Me/Notes, "Decision: <what>", with what, why and when, and tell them to move it to Team/Decisions in Knowledge.

If a repository deploys or releases, set what its files say about it as drafts in Me/<repository>/Runbooks, one page each for deploy, release and incident, only those its files support, for the person to move to Team/<repository>/Runbooks.

## 4. CLAUDE.md and AGENTS.md

A repository's own rules stay there. Once the person has moved the shared drafts to Team, propose, as a diff per repository, removing only the lines that repeat a Team/Conventions page, with one line in their place: "The conventions shared across projects are in Grenier: get Team/Conventions." Edit the files only once the person says yes to the diff.

## At the end

Sum up in a few lines: how many pages per folder, the drafts to move to Team, and what to confirm. Tell the person to run /grenier-setup again when their projects change a lot.
`;
