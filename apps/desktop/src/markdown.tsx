import type { ReactNode } from "react";

/** Markdown as React elements, never as HTML; a link opens only for `record:<id>`, http or https. */
export function Markdown({ text, open }: { text: string; open: (id: string) => void }) {
  return <div className="flex flex-col gap-2.5">{blocks(text, open)}</div>;
}

function blocks(text: string, open: (id: string) => void): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const key = out.length;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^```/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] as string)) code.push(lines[i++] as string);
      i++;
      out.push(
        <pre key={key} className="overflow-x-auto rounded-md bg-side px-3 py-2 font-mono text-sm">
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const content = inline(heading[2] as string, open);
      const level = (heading[1] as string).length;
      out.push(
        level === 1 ? (
          <h2 key={key} className="text-2xl font-semibold">
            {content}
          </h2>
        ) : level === 2 ? (
          <h3 key={key} className="text-xl font-semibold">
            {content}
          </h3>
        ) : (
          <h4 key={key} className="text-lg font-semibold">
            {content}
          </h4>
        ),
      );
      i++;
      continue;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2] as string);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] as string)) {
        items.push((lines[i++] as string).replace(/^\s*([-*]|\d+\.)\s+/, ""));
      }
      const children = items.map((item, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the items of a rendered text have no other identity
        <li key={n}>{inline(item, open)}</li>
      ));
      out.push(
        ordered ? (
          <ol key={key} className="list-decimal pl-5">
            {children}
          </ol>
        ) : (
          <ul key={key} className="list-disc pl-5">
            {children}
          </ul>
        ),
      );
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] as string).startsWith(">")) {
        quote.push((lines[i++] as string).replace(/^>\s?/, ""));
      }
      out.push(
        <blockquote key={key} className="border-l-2 border-line-strong pl-3 text-muted">
          {inline(quote.join(" "), open)}
        </blockquote>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== "" &&
      !/^(```|#{1,3}\s|\s*([-*]|\d+\.)\s|>)/.test(lines[i] as string)
    ) {
      paragraph.push(lines[i++] as string);
    }
    out.push(<p key={key}>{inline(paragraph.join(" "), open)}</p>);
  }
  return out;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string, open: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = out.length;
    const [, code, bold, italic, label, href] = match;
    if (code !== undefined) {
      out.push(
        <code key={key} className="rounded-sm bg-side px-1 font-mono text-sm">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      out.push(<strong key={key}>{inline(bold, open)}</strong>);
    } else if (italic !== undefined) {
      out.push(<em key={key}>{inline(italic, open)}</em>);
    } else if (label !== undefined && href !== undefined) {
      out.push(<Anchor key={key} label={label} href={href} open={open} />);
    }
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Anchor({ label, href, open }: { label: string; href: string; open: (id: string) => void }) {
  if (href.startsWith("record:")) {
    return (
      <button
        type="button"
        className="cursor-pointer text-accent underline underline-offset-2"
        onClick={() => open(href.slice("record:".length))}
      >
        {label}
      </button>
    );
  }
  if (!/^https?:\/\//.test(href)) return <>{label}</>;
  return (
    <a className="text-accent underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}
