import COMPONENTS from "../../desktop/src/laibe/components.css";
import TOKENS from "../../desktop/src/laibe/tokens.css";

/**
 * The web view: the desktop app's shell in its web variant (patterns/app-shell.md#variants), on the same copies of the
 * design system's tokens and components, with the gold accent. Text from records is only ever set as text.
 */
export const WEB = `<!doctype html>
<html lang="en" data-accent="gold">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grenier</title>
<style>
${TOKENS}
${COMPONENTS}
/* The shell's layout, as in the desktop app: no title bar, the browser is the frame. */
html, body { height: 100%; overflow: hidden; }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
select.input { cursor: pointer; }
::selection { background: var(--selection); }
.shell { display: grid; height: 100dvh; grid-template: "side main" minmax(0, 1fr) "status status" var(--layout-statusbar) / var(--layout-sidebar) minmax(0, 1fr); }
.shell > .sidebar { grid-area: side; z-index: var(--layer-bars); min-height: 0; }
#nav { display: contents; }
.sidebar-item:not(:hover, :focus-visible) > .tooltip { display: none; }
.content { grid-area: main; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
.content[data-list] { grid-template-columns: var(--layout-list) minmax(0, 1fr); }
.content > #list { display: none; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); }
.content[data-list] > #list { display: block; }
.content > #main { min-height: 0; overflow-y: auto; padding: var(--space-6); outline: none; }
.shell > .statusbar { grid-area: status; z-index: var(--layer-bars); }
.list-head { display: grid; gap: var(--space-2); padding: var(--space-3); border-bottom: 1px solid var(--line); }
.page { display: grid; gap: var(--space-4); align-content: start; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-2); }
.page-title { margin: 0; font: 600 var(--text-xl)/var(--leading-tight) var(--font-mono); letter-spacing: var(--tracking-tight); }
.page-intro { margin: var(--space-1) 0 0; color: var(--muted); }
.record { width: 100%; max-width: var(--layout-reading); margin: 0 auto; }
.meta { margin: 0; color: var(--muted); font: var(--text-xs)/var(--leading-snug) var(--font-mono); }
.reading { display: grid; gap: var(--space-3); font: var(--text-md)/var(--leading-normal) var(--font-sans); }
.reading h2, .reading h3, .reading h4 { margin: var(--space-2) 0 0; font-family: var(--font-mono); font-weight: 600; line-height: var(--leading-snug); }
.reading h2 { font-size: var(--text-xl); } .reading h3 { font-size: var(--text-lg); } .reading h4 { font-size: var(--text-md); }
.reading p, .reading ul, .reading ol { margin: 0; }
.reading a { color: var(--accent); }
.reading pre { margin: 0; padding: var(--space-2) var(--space-3); overflow-x: auto; background: var(--side); border: 1px solid var(--line); border-radius: var(--radius-md); font: var(--text-sm)/var(--leading-normal) var(--font-mono); }
.reading blockquote { margin: 0; padding-left: var(--space-3); border-left: 2px solid var(--line-strong); color: var(--muted); }
code { padding: 1px var(--space-1); background: var(--hover); border-radius: var(--radius-sm); font: var(--text-sm) var(--font-mono); }
pre code { padding: 0; background: none; }
.inline-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-2); }
.inline-form .field { flex: 1; min-width: 200px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
</head>
<body>
<div class="shell">
<nav class="sidebar" aria-label="Places"><div class="sidebar-app"><svg width="20" height="20" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="115" fill="#04050d"/><g fill="none" stroke="#fec000" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"><path d="M108 294 L256 166 L404 294"/><circle cx="256" cy="320" r="50" fill="#fff4de" stroke="none"/><path d="M256 284 V356 M220 320 H292" stroke="#04050d" stroke-width="12"/></g></svg></div><div id="nav"></div></nav>
<main class="content" id="content"><section id="list" aria-label="Records"></section><section id="main" tabindex="-1"></section></main>
<footer class="statusbar" id="status"></footer>
</div>
<script>
const $ = (id) => document.getElementById(id);
const main = $("main");
const list = $("list");
const content = $("content");
const nav = $("nav");
const status = $("status");
const SVG = "http://www.w3.org/2000/svg";
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
};
/* Lucide icons, drawn as the system's .icon. */
const ICONS = {
  store: ["M12 7v14", "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"],
  routines: ["m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"],
  team: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  usage: ["M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0", "M18.09 10.37A6 6 0 1 1 10.34 18", "M7 6h1v4", "m16.71 13.88.7.71-2.82 2.82"],
  search: ["m21 21-4.34-4.34", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M16 13H8", "M16 17H8"],
  back: ["m12 19-7-7 7-7", "M19 12H5"],
};
const icon = (name) => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};
const kbd = (...keys) => keys.length === 1 ? el("kbd", { class: "kbd", text: keys[0] }) : el("span", { class: "keys" }, ...keys.map((key) => el("kbd", { class: "kbd", text: key })));
const STATES = { "to-do": ["tag", "to-do"], doing: ["tag tag-accent", "doing"], running: ["tag tag-accent", "running"], done: ["tag tag-ok", "done"], failed: ["tag tag-err", "failed"], cut: ["tag tag-warn", "cut"], available: ["tag tag-ok", "available"], busy: ["tag tag-accent", "busy"], away: ["tag", "away"] };
const tag = (state) => {
  const [look, word] = STATES[state] || ["tag", state];
  return el("span", { class: look }, look.includes("tag-accent") ? el("i", { class: "tag-dot", "aria-hidden": "true" }) : null, word);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const exact = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const ago = (ts) => {
  if (!ts) return "never";
  const span = Date.now() - ts;
  if (span < 60000) return Math.max(1, Math.floor(span / 1000)) + "s";
  if (span < 3600000) return Math.floor(span / 60000) + "m";
  if (span < 86400000) return Math.floor(span / 3600000) + "h";
  const d = new Date(ts);
  return d.getDate() + " " + MONTHS[d.getMonth()];
};
const time = (ts) => el("time", { title: exact(ts), text: ago(ts) });
const money = (amount) => "$" + Number(amount).toFixed(2);
const problem = (text) => el("div", { class: "notice notice-danger", role: "alert" }, el("span", { class: "tag tag-err", text: "ERR" }), el("div", { class: "notice-text" }, el("p", { text: text })));
const empty = (boot, text, lit = true) => el("section", { class: lit ? "empty-region" : "" }, el("div", { class: "empty" },
  lit ? litPoint() : null,
  el("p", { class: "empty-boot" }, el("span", { class: "empty-prompt", text: ">" }), " " + boot, el("span", { class: "empty-cursor", "aria-hidden": "true" })),
  el("p", { class: "empty-text", text: text })));
const litPoint = () => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "empty-lit");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG, "circle");
  circle.setAttribute("cx", "24"); circle.setAttribute("cy", "24"); circle.setAttribute("r", "14");
  const bars = document.createElementNS(SVG, "path");
  bars.setAttribute("d", "M24 12 V36 M12 24 H36"); bars.setAttribute("fill", "none"); bars.setAttribute("stroke", "#04050d"); bars.setAttribute("stroke-width", "2.5"); bars.setAttribute("stroke-linecap", "round");
  svg.append(circle, bars);
  return svg;
};
const header = (title, intro, ...actions) => el("header", { class: "page-header" }, el("div", {}, el("h1", { class: "page-title", text: title }), intro ? el("p", { class: "page-intro", text: intro }) : null), actions.length ? el("div", { class: "cluster" }, ...actions) : null);
const table = (label, heads, rows, foot) => el("table", { class: "table", "aria-label": label },
  el("thead", {}, el("tr", {}, ...heads.map(([text, num]) => el("th", { class: num ? "num" : undefined, text: text })))),
  el("tbody", {}, ...rows),
  foot ? el("tfoot", {}, foot) : null);
const td = (content, look) => el("td", { class: look }, content);

/* Markdown as nodes, never as HTML: a link opens only for http or https. */
const LIST = new RegExp("^\\\\s*([-*]|\\\\d+\\\\.)\\\\s+");
const INLINE = new RegExp("\`([^\`]+)\`|\\\\*\\\\*([^*]+)\\\\*\\\\*|\\\\*([^*]+)\\\\*|\\\\[([^\\\\]]+)\\\\]\\\\(([^)\\\\s]+)\\\\)", "g");
function inline(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [, code, bold, italic, label, href] = match;
    if (code !== undefined) out.push(el("code", { text: code }));
    else if (bold !== undefined) out.push(el("strong", {}, ...inline(bold)));
    else if (italic !== undefined) out.push(el("em", {}, ...inline(italic)));
    else if (href.startsWith("https://") || href.startsWith("http://")) out.push(el("a", { href: href, target: "_blank", rel: "noreferrer", text: label }));
    else out.push(label);
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function markdown(text) {
  const lines = String(text || "").split("\\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (line.startsWith("\`\`\`")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("\`\`\`")) code.push(lines[i++]);
      i++;
      out.push(el("pre", { text: code.join("\\n") }));
      continue;
    }
    const level = line.startsWith("### ") ? 3 : line.startsWith("## ") ? 2 : line.startsWith("# ") ? 1 : 0;
    if (level) { out.push(el("h" + (level + 1), {}, ...inline(line.slice(level + 1)))); i++; continue; }
    if (LIST.test(line)) {
      const ordered = /\\d/.test(line.trim()[0]);
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(el("li", {}, ...inline(lines[i++].replace(LIST, ""))));
      out.push(el(ordered ? "ol" : "ul", {}, ...items));
      continue;
    }
    if (line.startsWith(">")) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\\s?/, ""));
      out.push(el("blockquote", {}, ...inline(quote.join(" "))));
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("\`\`\`") && !lines[i].startsWith("#") && !LIST.test(lines[i]) && !lines[i].startsWith(">")) paragraph.push(lines[i++]);
    out.push(el("p", {}, ...inline(paragraph.join(" "))));
  }
  return el("div", { class: "reading" }, ...out);
}

let token = localStorage.getItem("grenier-token");
let me = null;
let place = "store";
let hints = [];
async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: "Bearer " + token } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
  return body;
}
/* The status bar: the lit point, the app, who is signed in, and the keys that matter here. */
function bar(state) {
  status.replaceChildren(
    el("i", { class: "statusbar-dot", "aria-hidden": "true" }),
    el("span", { class: "statusbar-app", text: "Grenier" }),
    el("span", { text: state }),
    el("span", { class: "statusbar-hints" }, ...hints.map(([keys, says]) => el("span", { class: "statusbar-hint" }, kbd(...keys), says))),
  );
}
function show(...nodes) { main.replaceChildren(...nodes); }
function withList(on) { if (on) content.setAttribute("data-list", ""); else content.removeAttribute("data-list"); }

async function signIn() {
  const code = new URLSearchParams(location.hash.slice(1)).get("login");
  if (code) {
    const response = await fetch("/web/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code }) });
    const body = await response.json();
    history.replaceState(null, "", location.pathname);
    if (!response.ok) { bar("Signed out"); return show(problem(body.error)); }
    token = body.token;
    localStorage.setItem("grenier-token", token);
  }
  if (!token) {
    bar("Signed out");
    return show(empty("not signed in", "Sign in with the Web link on the Team screen of your Grenier app."));
  }
  try { me = await api("/api/me"); } catch (error) { localStorage.removeItem("grenier-token"); bar("Signed out"); return show(problem(error.message)); }
  bar("Signed in as " + me.name);
  // G then its letter: a second place with the same first letter takes its next free consonant.
  const places = [["store", "Store", store, "s"], ["routines", "Routines", routines, "r"], ["team", "Team", team, "m"]].concat(me.role === "admin" ? [["usage", "Usage", usage, "u"]] : []);
  const go = (name) => {
    place = name;
    for (const item of nav.children) {
      if (item.getAttribute("data-place") === name) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    places.find(([key]) => key === name)[2]();
  };
  nav.replaceChildren(...places.map(([key, label]) => el("a", { class: "sidebar-item badge-host", href: "#" + key, "data-place": key, "aria-label": label, onclick: (event) => { event.preventDefault(); go(key); } }, icon(key), el("span", { class: "tooltip tooltip-end", role: "tooltip", "aria-hidden": "true", text: label }))));
  for (const [key, , , letter] of places) keys["g " + letter] = () => go(key);
  go("store");
}

/* The keys the system shares: / or ⌘K searches, J/K move, Enter opens, Esc goes back, G then a letter goes. */
const keys = {};
let chord = null;
let chordTimer;
document.addEventListener("keydown", (event) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName);
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && key === "k") { event.preventDefault(); return keys.search && keys.search(); }
  if (typing) { if (key === "escape") event.target.blur(); return; }
  if (mod || event.altKey) return;
  if (chord) { const run = keys["g " + key]; chord = null; clearTimeout(chordTimer); if (run) { event.preventDefault(); run(); } return; }
  if (key === "g") { chord = "g"; chordTimer = setTimeout(() => (chord = null), 1500); return; }
  const run = { "/": keys.search, j: keys.next, arrowdown: keys.next, k: keys.previous, arrowup: keys.previous, enter: keys.open, escape: keys.back }[key];
  if (run) { event.preventDefault(); run(); }
});

/* Store: the records in the list, the open one at reading width. */
async function store() {
  withList(true);
  hints = [[["J", "K"], "move"], [["/"], "search"], [["G"], "go to"]];
  bar("Signed in as " + me.name);
  const q = el("input", { class: "input", type: "search", placeholder: "Search the store", "aria-label": "Search" });
  const type = el("select", { class: "input", "aria-label": "Type" }, el("option", { value: "", text: "Every type" }), ...["Doc", "Task", "Skill", "McpServer", "Routine"].map((t) => el("option", { value: t, text: t })));
  const rows = el("div", { class: "list", role: "listbox", "aria-label": "Records", tabindex: "0" });
  let records = [];
  let selected = -1;
  const select = (index) => {
    selected = Math.max(0, Math.min(records.length - 1, index));
    for (const [n, row] of Array.from(rows.children).entries()) row.setAttribute("aria-selected", String(n === selected));
    const record = records[selected];
    if (record) openRecord(record);
  };
  const load = async () => {
    const params = new URLSearchParams({ ...(q.value ? { q: q.value } : {}), ...(type.value ? { type: type.value } : {}) });
    try {
      records = (await api("/api/records?" + params)).records;
    } catch (error) {
      return list.replaceChildren(problem(error.message));
    }
    rows.replaceChildren(...records.map((record, index) => el("div", { class: "row", role: "option", "aria-selected": "false", onclick: () => select(index) },
      el("span", { class: "row-lead" }, icon("file")),
      el("span", { class: "row-title", text: record.title }),
      el("span", { class: "row-meta" }, time(record.updatedAt)),
      el("span", { class: "row-preview", text: record.type + " · " + record.top + " · " + record.author }))));
    list.replaceChildren(el("div", { class: "list-head" }, el("div", { class: "search" }, icon("search"), q, kbd("/")), type),
      records.length ? rows : (q.value || type.value ? empty("no match", "Nothing in the store matches. Try fewer words, or every type.", false) : empty("store empty", "What the team's people and agents learn lands here.")));
  };
  q.addEventListener("input", () => { clearTimeout(q.t); q.t = setTimeout(load, 250); });
  type.addEventListener("change", load);
  keys.search = () => q.focus();
  keys.next = () => select(selected + 1);
  keys.previous = () => select(selected - 1);
  keys.open = () => select(selected < 0 ? 0 : selected);
  keys.back = () => { selected = -1; for (const row of rows.children) row.setAttribute("aria-selected", "false"); show(empty("pick a record", "Open one from the list: J and K move through them.")); };
  keys.back();
  await load();
}
async function openRecord(record) {
  hints = [[["J", "K"], "move"], [["Esc"], "close"], [["/"], "search"]];
  bar("Signed in as " + me.name);
  let past = [];
  try { past = (await api("/api/records/" + record.id + "/history")).history; } catch (error) { return show(problem(error.message)); }
  const fields = Object.entries(record.fields || {}).filter(([, value]) => value !== "" && value !== null);
  show(el("article", { class: "record page" },
    el("header", {}, el("h1", { class: "page-title", text: record.title }),
      el("p", { class: "meta" }, record.type + " · " + record.top + " · by " + record.author + " · changed ", time(record.updatedAt))),
    record.body ? markdown(record.body) : el("p", { class: "meta", text: "Nothing written." }),
    fields.length ? el("section", { class: "section" }, el("header", { class: "section-header" }, el("h2", { class: "label", text: "Fields" })),
      ...fields.map(([key, value]) => el("div", { class: "section-row" }, el("span", { class: "label", text: key }), el("span", { text: typeof value === "string" ? value : JSON.stringify(value) })))) : null,
    record.links.length ? el("section", { class: "section" }, el("header", { class: "section-header" }, el("h2", { class: "label", text: "Links" })),
      ...record.links.map((link) => el("div", { class: "section-row" }, el("span", { class: "tag", text: link.kind }), el("code", { text: link.ref })))) : null,
    el("section", { class: "section" }, el("header", { class: "section-header" }, el("h2", { class: "label", text: "History" })),
      table("History", [["Version", true], ["By"], ["Saved"]], past.slice().reverse().map((h) => el("tr", {}, td(String(h.version), "num mono"), td(h.author + " on " + (h.device || "?")), td(exact(h.ts), "mono")))))));
}

async function routines() {
  withList(false);
  hints = [[["G"], "go to"]];
  bar("Signed in as " + me.name);
  let records, runs;
  try { [{ records }, { runs }] = await Promise.all([api("/api/records?type=Routine"), api("/api/runs")]); } catch (error) { return show(problem(error.message)); }
  show(el("div", { class: "page" }, header("Routines", "Tasks the team's machines run, and their last runs."),
    ...(records.length ? records.map((r) => {
      const mine = runs.filter((run) => run.routine_id === r.id).slice(0, 10);
      return el("section", { class: "section" },
        el("header", { class: "section-header" }, el("div", {}, el("h2", { class: "section-heading", text: r.title }), el("p", { class: "section-desc", text: r.fields.schedule ? "On a schedule, " + r.fields.schedule : "Run by hand" }))),
        mine.length ? table("Runs of " + r.title, [["State"], ["Machine"], ["Started"], ["API cost", true]], mine.map((run) => el("tr", {}, td(tag(run.status)), td(run.machine, "mono"), td(time(run.started_at), "mono"), td(money(run.cost), "num mono")))) : el("p", { class: "meta", text: "No run yet." }));
    }) : [empty("no routines yet", "An admin adds them in the Grenier app.")])));
}

async function team() {
  withList(false);
  hints = [[["G"], "go to"]];
  bar("Signed in as " + me.name);
  let members, machines;
  try { [{ members }, { machines }] = await Promise.all([api("/api/members"), api("/api/machines")]); } catch (error) { return show(problem(error.message)); }
  show(el("div", { class: "page" }, header("Team", "Who is in the team, and their machines."),
    el("section", { class: "section" }, el("header", { class: "section-header" }, el("h2", { class: "section-heading", text: "Members" })),
      table("Members", [["Name"], ["Role"], ["Machines"]], members.map((m) => el("tr", {}, td(m.name), td(el("span", { class: "tag", text: m.role })), td(m.devices.map((d) => d.name).join(", "), "mono"))))),
    el("section", { class: "section" }, el("header", { class: "section-header" }, el("h2", { class: "section-heading", text: "Machines" })),
      table("Machines", [["Machine"], ["Member"], ["State"], ["Runs, 30 days", true]], machines.map((m) => el("tr", {}, td(m.name, "mono"), td(m.member), td(tag(m.state)), td(String(m.runs || 0), "num mono")))))));
}

async function usage() {
  withList(false);
  hints = [[["G"], "go to"]];
  bar("Signed in as " + me.name);
  let rows;
  try { rows = (await api("/api/usage")).usage; } catch (error) { return show(problem(error.message)); }
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  const requestsMade = rows.reduce((sum, row) => sum + row.requests, 0);
  show(el("div", { class: "page" }, header("Usage", "The last 30 days, priced at API rates."),
    el("div", { class: "stats" }, el("div", { class: "stat" }, el("span", { class: "label", text: "API cost" }), el("span", { class: "stat-value stat-key", text: money(total) })),
      el("div", { class: "stat" }, el("span", { class: "label", text: "Requests" }), el("span", { class: "stat-value", text: String(requestsMade) })),
      el("div", { class: "stat" }, el("span", { class: "label", text: "Members" }), el("span", { class: "stat-value", text: String(new Set(rows.map((r) => r.member)).size) }))),
    table("Usage", [["Day"], ["Person"], ["Machine"], ["Repository"], ["Requests", true], ["API cost", true]],
      rows.map((r) => el("tr", {}, td(r.day, "mono"), td(r.member), td(r.machine, "mono"), td(r.repo || "–"), td(String(r.requests), "num mono"), td(money(r.cost), "num mono"))),
      el("tr", {}, el("td", { colspan: "4", text: "Total" }), el("td", { class: "num", text: String(requestsMade) }), el("td", { class: "num", text: money(total) })))));
}
signIn();
</script>
</body>
</html>
`;
