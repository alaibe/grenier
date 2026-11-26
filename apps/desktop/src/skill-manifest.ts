/** A SKILL.md as its front matter, kept as written, and its instructions. */
export function splitManifest(text: string): { front: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return match ? { front: match[1] ?? "", body: text.slice(match[0].length) } : { front: "", body: text };
}

export function joinManifest(front: string, body: string): string {
  return `---\n${front}\n---\n${body}`;
}

const LINE = /^description:[ \t]*(.*)$/m;

/** The front matter's one-line description; null when it spans lines (`>` or `|`), which is changed in the file. */
export function descriptionOf(front: string): string | null {
  const value = LINE.exec(front)?.[1]?.trim();
  if (value === undefined) return "";
  if (/^[>|]/.test(value)) return null;
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/** The front matter with a new one-line description, every other key as it was. */
export function withDescription(front: string, description: string): string {
  // A JSON string is a YAML double-quoted scalar: a ": " or a quote in it stays text.
  const line = `description: ${JSON.stringify(description.trim().replace(/\s+/g, " "))}`;
  return LINE.test(front) ? front.replace(LINE, line) : `${front}\n${line}`;
}
