import { describe, expect, it } from "vitest";
import { parseInvite, withTomlValue } from "../../../apps/cli/src/team.ts";

describe("invite links", () => {
  it("name the team store's host, the invite and its secret", () => {
    expect(parseInvite("grenier://join/grenier-team.acme.workers.dev/ab12/cd34")).toEqual({
      url: "https://grenier-team.acme.workers.dev",
      invite: "ab12",
      secret: "cd34",
    });
    expect(parseInvite("grenier://join/127.0.0.1:8787/ab/cd").url).toBe("http://127.0.0.1:8787");
    expect(() => parseInvite("https://example.com")).toThrow("grenier://join/");
  });
});

describe("withTomlValue", () => {
  it("adds a table, or sets a key inside an existing one, keeping the rest", () => {
    expect(withTomlValue("", "team", "url", "https://x")).toBe('[team]\nurl = "https://x"\n');
    expect(withTomlValue('[proxy]\nport = 1\n\n[team]\nurl = "old"\n', "team", "url", "new")).toBe(
      '[proxy]\nport = 1\n\n[team]\nurl = "new"\n',
    );
  });
});
