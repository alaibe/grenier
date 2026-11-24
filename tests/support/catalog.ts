export const SHA = "a1b2c3";

/** A GitHub repository of skills, as skills.sh's results point at it. */
export const REPO: Record<string, string> = {
  "README.md": "# Skills\n",
  "skills/notes/SKILL.md": "---\nname: release-notes\ndescription: Writes release notes.\n---\nRead the log.\n",
  "skills/notes/template.md": "## Changes\n",
  "skills/notes/.env": "TOKEN=1\n",
  "skills/other/SKILL.md": "---\nname: other\n---\nSomething else.\n",
};

/** Answers like skills.sh, GitHub's API and raw.githubusercontent.com, and records each URL it was asked. */
export function fakeWeb(repo: Record<string, string> = REPO) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("https://skills.sh/api/search?")) {
      return Response.json({
        skills: [
          { id: "acme/skills/release-notes", name: "release-notes", installs: 1200, source: "acme/skills" },
          { id: "acme/tools/lint", name: "lint", installs: 3, source: "" },
          { id: "x", name: "bad source", installs: 1, source: "not a repo" },
          { name: "no id" },
        ],
      });
    }
    if (url === "https://api.github.com/repos/acme/skills/commits/HEAD") return Response.json({ sha: SHA });
    if (url === `https://api.github.com/repos/acme/skills/git/trees/${SHA}?recursive=1`) {
      return Response.json({
        tree: Object.entries(repo).map(([path, text]) => ({ path, type: "blob", size: text.length })),
      });
    }
    const raw = `https://raw.githubusercontent.com/acme/skills/${SHA}/`;
    if (url.startsWith(raw) && repo[url.slice(raw.length)] !== undefined)
      return new Response(repo[url.slice(raw.length)]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}
