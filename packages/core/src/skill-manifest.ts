import { Document, parseDocument } from "yaml";

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A SKILL.md as its YAML front matter, kept as written, and its instructions. */
export function splitManifest(text: string): { front: string; body: string } {
  const match = FRONT.exec(text);
  return match ? { front: match[1] ?? "", body: text.slice(match[0].length) } : { front: "", body: text };
}

export function joinManifest(front: string, body: string): string {
  return `---\n${front}\n---\n${body}`;
}

/** A text field of the front matter, as `name` or `description`. */
export function frontField(front: string, key: string): string | undefined {
  const value = parseDocument(front).get(key);
  return typeof value === "string" ? value.trim() : undefined;
}

/** A field of a SKILL.md's front matter. */
export const manifestField = (text: string, key: string) => frontField(splitManifest(text).front, key);

const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

/** The front matter with a new one-line description, every other key and comment as it was. */
export function withDescription(front: string, description: string): string {
  const document = parseDocument(front);
  document.set("description", oneLine(description));
  return document.toString().replace(/\n$/, "");
}

/** A SKILL.md from a name, a one-line description and the instructions. */
export function newManifest(input: { name: string; description: string; instructions: string }): string {
  const front = new Document({ name: input.name, description: oneLine(input.description) }).toString();
  return joinManifest(front.replace(/\n$/, ""), `${input.instructions.trim()}\n`);
}
