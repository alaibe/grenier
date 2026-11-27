import { GFM, parser } from "@lezer/markdown";

/** A page's Markdown as the web view draws it: text, or an allowed tag with its children. Never HTML. */
export type ViewNode = string | { tag: string; href?: string; children: ViewNode[] };

const markdown = parser.configure(GFM);

/** Each Markdown node the web view draws, by the tag it draws it as. */
const TAGS: Record<string, string> = {
  Paragraph: "p",
  ATXHeading1: "h2",
  ATXHeading2: "h3",
  ATXHeading3: "h4",
  ATXHeading4: "h5",
  ATXHeading5: "h6",
  ATXHeading6: "h6",
  SetextHeading1: "h2",
  SetextHeading2: "h3",
  BulletList: "ul",
  OrderedList: "ol",
  ListItem: "li",
  Blockquote: "blockquote",
  FencedCode: "pre",
  CodeBlock: "pre",
  InlineCode: "code",
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "del",
  Link: "a",
  Table: "table",
  TableHeader: "tr",
  TableRow: "tr",
  TableCell: "td",
  HorizontalRule: "hr",
};

/** Syntax, not content: the marks around text, and a link's URL, which becomes its href. */
const SKIPPED = new Set([
  "EmphasisMark",
  "HeaderMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "URL",
  "LinkTitle",
  "QuoteMark",
  "ListMark",
  "TableDelimiter",
  "StrikethroughMark",
  "TaskMarker",
]);

/** Tags that hold blocks, not text. */
const BLOCKS = new Set(["ul", "ol", "li", "blockquote", "table", "tr", "hr"]);
/** Tags whose text runs over lines, joined back into one. */
const INLINE_ROOTS = new Set(["p", "h2", "h3", "h4", "h5", "h6", "td", "th"]);

function tidied(parts: ViewNode[]): ViewNode[] {
  const joined = parts.map((part) => (typeof part === "string" ? part.replace(/\s*\n\s*/g, " ") : part));
  const first = joined[0];
  if (typeof first === "string") joined[0] = first.trimStart();
  const last = joined.at(-1);
  if (typeof last === "string") joined[joined.length - 1] = last.trimEnd();
  return joined.filter((part) => part !== "");
}

interface Parsed {
  name: string;
  from: number;
  to: number;
  children: Parsed[];
}

function parsed(text: string): Parsed {
  const root: Parsed = { name: "Document", from: 0, to: text.length, children: [] };
  const stack = [root];
  markdown.parse(text).iterate({
    enter: (node) => {
      if (node.name === "Document") return;
      const entry: Parsed = { name: node.name, from: node.from, to: node.to, children: [] };
      stack.at(-1)?.children.push(entry);
      stack.push(entry);
    },
    leave: (node) => {
      if (node.name !== "Document") stack.pop();
    },
  });
  return root;
}

function convert(text: string, node: Parsed, inHeader: boolean): ViewNode[] {
  // Code keeps its text whole; its marks and info string are not part of it.
  if (node.name === "FencedCode" || node.name === "CodeBlock") {
    const code = node.children.filter((child) => child.name === "CodeText");
    return [{ tag: "pre", children: [code.map((child) => text.slice(child.from, child.to)).join("\n")] }];
  }
  const children: ViewNode[] = [];
  let at = node.from;
  const header = inHeader || node.name === "TableHeader";
  for (const child of node.children) {
    if (child.from > at) children.push(text.slice(at, child.from));
    if (!SKIPPED.has(child.name)) children.push(...convert(text, child, header));
    at = child.to;
  }
  if (node.to > at) children.push(text.slice(at, node.to));
  let tag = TAGS[node.name];
  // Between blocks, whitespace is layout; inside a paragraph, heading or cell, lines join with a space.
  const blocks = children.filter((part) => typeof part !== "string" || part.trim() !== "");
  if (!tag) return blocks;
  if (BLOCKS.has(tag)) return [{ tag, children: blocks }];
  const content = INLINE_ROOTS.has(tag) ? tidied(children) : children;
  if (tag === "td" && header) tag = "th";
  if (tag === "a") {
    const url = node.children.find((child) => child.name === "URL");
    const href = url ? text.slice(url.from, url.to) : "";
    // A link opens only for http or https; anything else stays its text.
    if (!/^https?:\/\//i.test(href)) return content;
    return [{ tag, href, children: content }];
  }
  return [{ tag, children: content }];
}

/** A page's Markdown, with GitHub's tables, lists and strikethrough, as nodes the web view draws as text. */
export function viewOf(text: string): ViewNode[] {
  return convert(text, parsed(text), false);
}
