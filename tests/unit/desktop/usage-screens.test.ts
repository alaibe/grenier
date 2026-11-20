import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCREENS, type ViewName } from "../../../apps/desktop/src/usage/screens.ts";

// A01 and A02 of the usage statistics' shared suite. Grenier has no A03: it has no set-up step and no lock.

const usage = readFileSync(new URL("../../../apps/desktop/src-tauri/src/usage.rs", import.meta.url), "utf8");
const rows = [...usage.matchAll(/^ {4}\w+ => "([^"]*)", "([^"]*)";$/gm)].map(([, url, title]) => ({ url, title }));

describe("the screens usage statistics name", () => {
  it("A01 view state maps to screens, never to ids", () => {
    for (const [name, { url }] of Object.entries(SCREENS) as [ViewName, (typeof SCREENS)[ViewName]][]) {
      expect(url).toBe(`/${name}`);
      expect(url).toMatch(/^\/[a-z]+$/);
    }
  });

  it("A02 the list matches the app's views", () => {
    expect(rows).toEqual(Object.values(SCREENS));
  });
});
