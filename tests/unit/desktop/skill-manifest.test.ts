import { describe, expect, it } from "vitest";
import {
  descriptionOf,
  joinManifest,
  splitManifest,
  withDescription,
} from "../../../apps/desktop/src/skill-manifest.ts";

const SKILL = "---\nname: notes\ndescription: 'Writes notes: it''s quick.'\nallowed-tools: Read\n---\n# Steps\n";

describe("a skill's SKILL.md in the Skills screen", () => {
  it("splits into front matter and instructions, and joins back as it was", () => {
    const { front, body } = splitManifest(SKILL);
    expect(body).toBe("# Steps\n");
    expect(joinManifest(front, body)).toBe(SKILL);
    expect(splitManifest("No front matter.")).toEqual({ front: "", body: "No front matter." });
  });

  it("reads and changes the one-line description, keeping every other key", () => {
    const { front } = splitManifest(SKILL);
    expect(descriptionOf(front)).toBe("Writes notes: it's quick.");
    const changed = withDescription(front, 'Writes "release" notes.');
    expect(changed).toBe('name: notes\ndescription: "Writes \\"release\\" notes."\nallowed-tools: Read');
    expect(descriptionOf(changed)).toBe('Writes "release" notes.');
    expect(descriptionOf("name: x\ndescription: >\n  Folded.")).toBeNull();
    expect(withDescription("name: x", "New.")).toBe('name: x\ndescription: "New."');
  });
});
