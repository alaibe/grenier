import {
  frontField,
  joinManifest,
  manifestField,
  newManifest,
  splitManifest,
  withDescription,
} from "@grenier/core/skill-manifest";
import { describe, expect, it } from "vitest";

const SKILL =
  "---\nname: notes\n# kept\ndescription: 'Writes notes: it''s quick.'\nallowed-tools: Read\n---\n# Steps\n";

describe("a SKILL.md", () => {
  it("splits into front matter and instructions, and joins back as it was", () => {
    const { front, body } = splitManifest(SKILL);
    expect(body).toBe("# Steps\n");
    expect(joinManifest(front, body)).toBe(SKILL);
    expect(splitManifest("No front matter.")).toEqual({ front: "", body: "No front matter." });
    expect(splitManifest("---\r\nname: a\r\n---\r\nGo.").body).toBe("Go.");
  });

  it("reads a field on one line, quoted, folded or kept under the key", () => {
    expect(manifestField('---\nname: a\ndescription: "One: line."\n---\n', "description")).toBe("One: line.");
    expect(manifestField("---\ndescription: >\n  Folded over\n  two lines.\nname: a\n---\n", "description")).toBe(
      "Folded over two lines.",
    );
    expect(manifestField("---\ndescription: |\n  Kept\n  apart.\n---\n", "description")).toBe("Kept\napart.");
    expect(manifestField("---\nmetadata:\n  description: nested\n---\n", "description")).toBeUndefined();
  });

  it("changes the description, keeping every other key and comment", () => {
    const { front } = splitManifest(SKILL);
    expect(frontField(front, "description")).toBe("Writes notes: it's quick.");
    const changed = withDescription(front, 'Writes "release"\n notes.');
    expect(frontField(changed, "description")).toBe('Writes "release" notes.');
    expect(changed).toContain("# kept");
    expect(frontField(changed, "allowed-tools")).toBe("Read");
    expect(frontField(withDescription(front, "Folded: >"), "description")).toBe("Folded: >");
  });

  it("writes a new one from a name, a description and the instructions", () => {
    const text = newManifest({ name: "notes", description: "Writes notes: from tags.", instructions: "Go." });
    expect(manifestField(text, "name")).toBe("notes");
    expect(manifestField(text, "description")).toBe("Writes notes: from tags.");
    expect(splitManifest(text).body).toBe("Go.\n");
  });
});
