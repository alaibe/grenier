import { describe, expect, it } from "vitest";
import { viewOf } from "../../../apps/server/src/markdown.ts";

describe("a page as the web view draws it", () => {
  it("keeps GitHub's tables, nested lists, code and strikethrough", () => {
    const view = viewOf(
      "# Release\n\nTag it, then `pnpm build`\nand ~~wait~~.\n\n- one\n  - nested\n\n| Step | Who |\n|---|---|\n| Tag | Ada |\n\n```sh\npnpm build\n```",
    );
    expect(view).toEqual([
      { tag: "h2", children: ["Release"] },
      {
        tag: "p",
        children: [
          "Tag it, then ",
          { tag: "code", children: ["pnpm build"] },
          " and ",
          { tag: "del", children: ["wait"] },
          ".",
        ],
      },
      {
        tag: "ul",
        children: [
          {
            tag: "li",
            children: [
              { tag: "p", children: ["one"] },
              { tag: "ul", children: [{ tag: "li", children: [{ tag: "p", children: ["nested"] }] }] },
            ],
          },
        ],
      },
      {
        tag: "table",
        children: [
          {
            tag: "tr",
            children: [
              { tag: "th", children: ["Step"] },
              { tag: "th", children: ["Who"] },
            ],
          },
          {
            tag: "tr",
            children: [
              { tag: "td", children: ["Tag"] },
              { tag: "td", children: ["Ada"] },
            ],
          },
        ],
      },
      { tag: "pre", children: ["pnpm build"] },
    ]);
  });

  it("links only to http or https, and passes HTML on as text", () => {
    expect(viewOf("[docs](https://grenier.laibe.cc) [x](javascript:alert(1)) <img src=x onerror=alert(1)>")).toEqual([
      {
        tag: "p",
        children: [
          { tag: "a", href: "https://grenier.laibe.cc", children: ["docs"] },
          " ",
          "x",
          " ",
          "<img src=x onerror=alert(1)>",
        ],
      },
    ]);
  });
});
