import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Link, RecordRow } from "@grenier/core/api";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { searchRecords } from "../api.ts";

class Bullet extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

class Rule extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const line = document.createElement("span");
    line.className = "cm-md-rule";
    return line;
  }
}

const hidden = Decoration.replace({});
const editingOf = (editable: boolean) => [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
const bullet = Decoration.replace({ widget: new Bullet() });
const rule = Decoration.replace({ widget: new Rule() });
const mark = (className: string) => Decoration.mark({ class: className });
const line = (className: string) => Decoration.line({ class: className });

/** Where a link goes, if it may: a page (`record:<id>`), or an http or https address. */
function target(href: string): string | null {
  return href.startsWith("record:") || /^https?:\/\//.test(href) ? href : null;
}

/** Markdown shown as it reads, marks hidden and blocks styled, but as written on the caret's lines: the text never changes. */
function livePreview(view: EditorView): DecorationSet {
  const { state } = view;
  const active = new Set<number>();
  if (view.hasFocus && view.state.facet(EditorView.editable)) {
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let at = first; at <= last; at++) active.add(at);
    }
  }
  const shown = (from: number) => active.has(state.doc.lineAt(from).number);
  const hideWithSpace = (from: number, to: number) =>
    out.push(hidden.range(from, to + (state.sliceDoc(to, to + 1) === " " ? 1 : 0)));
  const out: Range<Decoration>[] = [];
  const lines = (from: number, to: number, className: string) => {
    for (let at = state.doc.lineAt(from).number; at <= state.doc.lineAt(to).number; at++) {
      out.push(line(className).range(state.doc.line(at).from));
    }
  };
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(line(`cm-md-h${Math.min(3, Number(heading[1]))}`).range(state.doc.lineAt(node.from).from));
        } else if ((name === "HeaderMark" || name === "QuoteMark") && !shown(node.from)) {
          hideWithSpace(node.from, node.to);
        } else if (name === "StrongEmphasis") out.push(mark("cm-md-strong").range(node.from, node.to));
        else if (name === "Emphasis") out.push(mark("cm-md-em").range(node.from, node.to));
        else if (name === "Strikethrough") out.push(mark("cm-md-strike").range(node.from, node.to));
        else if (name === "InlineCode") out.push(mark("cm-md-code").range(node.from, node.to));
        else if ((name === "EmphasisMark" || name === "StrikethroughMark") && !shown(node.from)) {
          out.push(hidden.range(node.from, node.to));
        } else if ((name === "CodeMark" || name === "CodeInfo") && !shown(node.from)) {
          out.push(hidden.range(node.from, node.to));
        } else if (name === "Link") {
          const url = node.node.getChild("URL");
          const href = url ? target(state.sliceDoc(url.from, url.to)) : null;
          const marks = node.node.getChildren("LinkMark");
          const open = marks[0];
          const close = marks[1];
          if (!open || !close) return;
          out.push(
            Decoration.mark({
              class: "cm-md-link",
              attributes: href ? { "data-href": href, title: "⌘-click to open" } : {},
            }).range(open.to, close.from),
          );
          if (!shown(node.from)) {
            out.push(hidden.range(open.from, open.to));
            out.push(hidden.range(close.from, node.to));
          }
          return false;
        } else if (name === "Blockquote") lines(node.from, node.to, "cm-md-quote");
        else if (name === "FencedCode") lines(node.from, node.to, "cm-md-fence");
        else if (name === "ListMark") {
          const text = state.sliceDoc(node.from, node.to);
          if (/^[-*+]$/.test(text) && !shown(node.from)) out.push(bullet.range(node.from, node.to));
          else out.push(mark("cm-md-listmark").range(node.from, node.to));
        } else if (name === "HorizontalRule" && !shown(node.from)) out.push(rule.range(node.from, node.to));
        return undefined;
      },
    });
  }
  return Decoration.set(out, true);
}

const preview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = livePreview(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
        this.decorations = livePreview(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** `@` and a few letters offers the pages that match: picking one writes a link to it. */
function mentions(linked: (link: Link) => void) {
  return async (context: CompletionContext) => {
    const word = context.matchBefore(/(?:^|\s)@[^\s@][^@\n]{0,40}$/);
    if (!word) return null;
    const at = word.text.indexOf("@");
    const query = word.text.slice(at + 1);
    if (query.length < 2) return null;
    await new Promise((settle) => setTimeout(settle, 150));
    if (context.aborted) return null;
    const found = await searchRecords<RecordRow>(query).catch(() => null);
    if (!found || context.aborted) return null;
    return {
      from: word.from + at,
      filter: false,
      options: found.slice(0, 6).map(
        (record): Completion => ({
          label: record.title,
          type: "text",
          apply: (view, _completion, from, to) => {
            const text = `[${record.title}](record:${record.id})`;
            view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
            linked({ kind: "record", ref: record.id });
          },
        }),
      ),
    };
  };
}

/** The Reading role, mono headings and the system's colours, here as CodeMirror's own styles beat the stylesheet's layers. */
const look = EditorView.theme({
  "&": {
    color: "var(--fg)",
    background: "transparent",
    font: "var(--text-md) / var(--leading-normal) var(--font-sans)",
  },
  "&.cm-focused, .cm-content:focus-visible": { outline: "none", boxShadow: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { padding: "0", minHeight: "320px", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { background: "var(--selection)" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-md-h1, .cm-md-h2, .cm-md-h3": {
    fontFamily: "var(--font-mono)",
    fontWeight: "600",
    lineHeight: "var(--leading-snug)",
    letterSpacing: "var(--tracking-tight)",
  },
  ".cm-md-h1": { fontSize: "var(--text-xl)", paddingTop: "var(--space-4) !important" },
  ".cm-md-h2": { fontSize: "var(--text-lg)", paddingTop: "var(--space-3) !important" },
  ".cm-md-h3": { fontSize: "var(--text-md)", paddingTop: "var(--space-2) !important" },
  ".cm-md-strong": { fontWeight: "600" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", color: "var(--muted)" },
  ".cm-md-code": {
    padding: "1px var(--space-1)",
    background: "var(--hover)",
    borderRadius: "var(--radius-sm)",
    font: "var(--text-sm) var(--font-mono)",
  },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-md-link[data-href]": { cursor: "pointer" },
  ".cm-md-quote": {
    borderLeft: "2px solid var(--line-strong)",
    paddingLeft: "var(--space-3) !important",
    color: "var(--muted)",
  },
  ".cm-md-fence": {
    background: "var(--side)",
    font: "var(--text-sm) / var(--leading-normal) var(--font-mono)",
    paddingInline: "var(--space-3) !important",
  },
  ".cm-md-bullet, .cm-md-listmark": { color: "var(--muted)" },
  ".cm-md-rule": {
    display: "inline-block",
    width: "100%",
    borderTop: "1px solid var(--line)",
    verticalAlign: "middle",
  },
  ".cm-tooltip": { border: "none", background: "transparent" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", maxHeight: "240px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--hover)", color: "var(--fg)" },
});

/** ⌘↵ saves the page, so the editor leaves it to the app's commands. */
const keys = keymap.of([...defaultKeymap.filter((binding) => binding.key !== "Mod-Enter"), ...historyKeymap]);

/** A page's Markdown edited as it reads (live preview): `@` links a page, ⌘-click (or a click when read-only) opens a link. */
export function MarkdownEditor({
  value,
  editable,
  label,
  onChange,
  onLink,
  open,
  ref,
}: {
  /** Lets the page put the caret in the text. */
  ref?: Ref<{ focus: () => void }>;
  value: string;
  editable: boolean;
  label: string;
  onChange: (text: string) => void;
  /** A link to a page, written through `@`. */
  onLink: (link: Link) => void;
  open: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editing = useRef(new Compartment());
  const latest = useRef({ onChange, onLink, open });
  latest.current = { onChange, onLink, open };
  // The text it last sent out: the same value coming back needs no comparison with the whole document.
  const sent = useRef(value);
  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: made once; value and editable follow below
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          keys,
          EditorView.lineWrapping,
          look,
          placeholder(editable ? "Write here. @ links another page." : "Nothing written yet."),
          editing.current.of(editingOf(editable)),
          EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }),
          preview,
          autocompletion({
            override: [mentions((link) => latest.current.onLink(link))],
            icons: false,
            tooltipClass: () => "menu",
            optionClass: () => "menu-item",
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            sent.current = update.state.doc.toString();
            latest.current.onChange(sent.current);
          }),
          EditorView.domEventHandlers({
            click: (event, editor) => {
              const link = (event.target as HTMLElement).closest<HTMLElement>("[data-href]");
              const href = link?.dataset.href;
              if (!href || (editor.state.facet(EditorView.editable) && !(event.metaKey || event.ctrlKey))) return false;
              event.preventDefault();
              if (href.startsWith("record:")) latest.current.open(href.slice("record:".length));
              else window.open(href, "_blank", "noreferrer");
              return true;
            },
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current || value === sent.current) return;
    sent.current = value;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editing.current.reconfigure(editingOf(editable)),
    });
  }, [editable]);

  return <div ref={host} />;
}
