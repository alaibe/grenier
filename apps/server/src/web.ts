import TOKENS from "../../desktop/src/laibe/tokens.css";

/** The web view, on the laibe design system with the gold accent. Text from records is only ever set as text, never as HTML. */
export const WEB = `<!doctype html>
<html lang="en" data-accent="gold">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grenier</title>
<style>
${TOKENS}
  * { box-sizing: border-box; }
  html { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; font: var(--text-md)/var(--leading-normal) var(--font-sans); background: var(--bg); color: var(--fg); }
  ::selection { background: var(--selection); }
  header { position: sticky; top: 0; z-index: 10; display: flex; gap: 16px; align-items: center; height: 48px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--side); flex-wrap: wrap; }
  header .brand { display: flex; align-items: center; gap: 10px; margin-right: auto; font: 600 var(--text-sm) var(--font-mono); }
  nav { display: flex; gap: 2px; }
  button { font: 500 var(--text-sm) var(--font-mono); height: var(--control-md); padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg); cursor: pointer; transition: background var(--duration-instant); }
  button:hover { background: var(--hover); }
  nav button { border-color: transparent; background: none; color: var(--muted); }
  nav button:hover { color: var(--fg); background: var(--hover); }
  nav button[aria-current="page"] { color: var(--accent); background: var(--accent-soft); }
  button.primary { border: 0; background: var(--accent); color: var(--on-accent); clip-path: polygon(0 0, calc(100% - var(--chamfer-sm)) 0, 100% var(--chamfer-sm), 100% 100%, 0 100%); }
  button.primary:hover { background: var(--accent-strong); }
  main { flex: 1; width: 100%; max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
  input, select, textarea { font: var(--text-sm) var(--font-sans); height: var(--control-md); padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--panel); color: var(--fg); }
  input { flex: 1; min-width: 200px; }
  input::placeholder { color: var(--subtle); }
  a { color: var(--fg); text-decoration: none; }
  a:hover { color: var(--accent); }
  h2 { margin: 16px 0 4px; font: 600 var(--text-xl)/var(--leading-tight) var(--font-mono); letter-spacing: var(--tracking-tight); }
  h3 { margin: 24px 0 8px; font: 500 var(--text-xs) var(--font-mono); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--muted); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px 16px; margin-bottom: 8px; }
  .card h3 { margin: 0 0 4px; font: 500 var(--text-md) var(--font-sans); letter-spacing: normal; text-transform: none; color: var(--fg); }
  .muted { color: var(--muted); font: var(--text-xs) var(--font-mono); }
  p { color: var(--muted); }
  [role="alert"] { color: var(--danger); }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 12px 16px; font: var(--text-sm)/1.6 var(--font-mono); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-md); }
  table { border-collapse: collapse; width: 100%; font-size: var(--text-sm); }
  th { font: 500 var(--text-xs) var(--font-mono); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--muted); }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
  td.n { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  footer { position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px; height: var(--layout-statusbar); padding: 0 12px; border-top: 1px solid var(--line); background: var(--side); font: var(--text-xs) var(--font-mono); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--muted); }
  footer i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: var(--glow); }
  :focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
</style>
</head>
<body>
<header><span class="brand"><svg width="20" height="20" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="115" fill="#04050d"/><g fill="none" stroke="#fec000" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"><path d="M108 294 L256 166 L404 294"/><circle cx="256" cy="320" r="50" fill="#fff4de" stroke="none"/><path d="M256 284 V356 M220 320 H292" stroke="#04050d" stroke-width="12"/></g></svg>Grenier</span><nav id="nav"></nav></header>
<main id="main"><p>Loading…</p></main>
<footer><i></i>Grenier · team store</footer>
<script>
const main = document.getElementById("main");
const nav = document.getElementById("nav");
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
};
let token = localStorage.getItem("grenier-token");
let me = null;
async function api(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: "Bearer " + token } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
  return body;
}
async function signIn() {
  const code = new URLSearchParams(location.hash.slice(1)).get("login");
  if (code) {
    const response = await fetch("/web/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const body = await response.json();
    history.replaceState(null, "", "/");
    if (!response.ok) return show(el("p", { text: body.error }));
    token = body.token;
    localStorage.setItem("grenier-token", token);
  }
  if (!token) return show(el("p", { text: "Sign in with the Web link on the Team screen of your Grenier app" }));
  try { me = await api("/api/me"); } catch (error) { localStorage.removeItem("grenier-token"); return show(el("p", { text: error.message })); }
  const views = { Store: store, Requests: requests, Routines: routines, Team: team, ...(me.role === "admin" ? { Usage: usage } : {}) };
  nav.replaceChildren(...Object.entries(views).map(([name, view]) => el("button", { text: name, onclick: (event) => { for (const b of nav.children) b.removeAttribute("aria-current"); event.target.setAttribute("aria-current", "page"); view(); } })));
  nav.firstChild.setAttribute("aria-current", "page");
  store();
}
function show(...nodes) { main.replaceChildren(...nodes); }
function recordCard(record, open) {
  return el("div", { class: "card" },
    el("h3", {}, open ? el("a", { href: "#", text: record.title, onclick: (event) => { event.preventDefault(); open(record); } }) : record.title),
    el("div", { class: "muted", text: record.type + (record.kind ? " · " + record.kind : "") + " · " + record.top + " · " + record.author + " · " + new Date(record.updatedAt).toLocaleString() }));
}
async function store() {
  const q = el("input", { placeholder: "Search the store", "aria-label": "Search" });
  const type = el("select", { "aria-label": "Type" }, el("option", { value: "", text: "Every type" }), ...["Project","Task","Meeting","Decision","Doc","Person","Memory","Skill","McpServer","Routine"].map((t) => el("option", { value: t, text: t })));
  const list = el("div");
  const load = async () => {
    const params = new URLSearchParams({ ...(q.value ? { q: q.value } : {}), ...(type.value ? { type: type.value } : {}) });
    const { records } = await api("/api/records?" + params);
    list.replaceChildren(...(records.length ? records.map((r) => recordCard(r, openRecord)) : [el("p", { class: "muted", text: "Nothing yet." })]));
  };
  q.addEventListener("input", () => { clearTimeout(q.t); q.t = setTimeout(load, 250); });
  type.addEventListener("change", load);
  show(el("div", { class: "row" }, q, type), list);
  load();
}
async function openRecord(record) {
  const { history } = await api("/api/records/" + record.id + "/history");
  show(
    el("button", { text: "Back", onclick: store }),
    el("h2", { text: record.title }),
    el("p", { class: "muted", text: record.type + " · " + record.top + " · by " + record.author }),
    el("pre", { text: record.body }),
    el("h3", { text: "Fields" }), el("pre", { text: JSON.stringify(record.fields, null, 2) }),
    el("h3", { text: "Links" }), el("pre", { text: record.links.map((l) => l.kind + ": " + l.ref).join("\\n") || "None" }),
    el("h3", { text: "History" }),
    el("table", {}, el("tbody", {}, ...history.map((h) => el("tr", {}, el("td", { text: "v" + h.version }), el("td", { text: h.author + " on " + (h.device || "?") }), el("td", { text: new Date(h.ts).toLocaleString() }))))),
  );
}
async function requests() {
  const [{ records: tasks }, { records: routineList }] = await Promise.all([api("/api/records?type=Task"), api("/api/records?type=Routine")]);
  const column = (status) => el("div", {}, el("h3", { text: status }), ...tasks.filter((t) => t.fields.status === status && t.fields.routine).map((t) => recordCard(t)));
  const board = el("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem" }, column("to-do"), column("doing"), column("done"));
  // The store takes a request from an admin only.
  if (me.role !== "admin") return show(board);
  if (!routineList.length) return show(el("p", { class: "muted", text: "No routine yet." }), board);
  const routine = el("select", { "aria-label": "Routine" }, ...routineList.map((r) => el("option", { value: r.id, text: r.title })));
  const title = el("input", { placeholder: "What to do", "aria-label": "Request" });
  const said = el("p", { role: "alert" });
  const file = el("button", { class: "primary", text: "File the request", onclick: async () => {
    if (!title.value.trim() || !routine.value) return;
    said.textContent = "";
    const id = crypto.randomUUID().replace(/-/g, "");
    try {
      const { refused } = await api("/api/changes", { method: "POST", body: JSON.stringify({ changes: [{ id, recordId: id, baseVersion: 0, changed: ["top","type","title","fields","links"], record: { id, top: routineList.find((r) => r.id === routine.value).top, type: "Task", title: title.value.trim(), fields: { status: "to-do", routine: routine.value }, links: [{ kind: "record", ref: routine.value }] } }] }) });
      if (refused.length) return (said.textContent = "Not filed: " + refused[0].reason);
    } catch (error) {
      return (said.textContent = "Not filed: " + error.message);
    }
    requests();
  } });
  show(el("div", { class: "row" }, routine, title, file), said, board);
}
async function routines() {
  const [{ records }, { runs }] = await Promise.all([api("/api/records?type=Routine"), api("/api/runs")]);
  show(...records.map((r) => el("div", { class: "card" }, el("h3", { text: r.title }),
    el("div", { class: "muted", text: r.fields.trigger || "request" }),
    el("table", {}, el("tbody", {}, ...runs.filter((run) => run.routine_id === r.id).slice(0, 10).map((run) => el("tr", {}, el("td", { text: run.machine }), el("td", { text: run.status }), el("td", { class: "n", text: "$" + Number(run.cost).toFixed(2) }), el("td", { text: new Date(run.started_at).toLocaleString() })))))))
    , ...(records.length ? [] : [el("p", { class: "muted", text: "No routine yet." })]));
}
async function team() {
  const [{ members }, { machines }] = await Promise.all([api("/api/members"), api("/api/machines")]);
  show(el("h3", { text: "Members" }), el("table", {}, el("tbody", {}, ...members.map((m) => el("tr", {}, el("td", { text: m.name }), el("td", { text: m.role }), el("td", { text: m.devices.map((d) => d.name).join(", ") }))))),
    el("h3", { text: "Machines" }), el("table", {}, el("tbody", {}, ...machines.map((m) => el("tr", {}, el("td", { text: m.name }), el("td", { text: m.member }), el("td", { text: m.state }), el("td", { class: "n", text: String(m.runs ?? 0) + " runs" }))))));
}
async function usage() {
  const { usage: rows } = await api("/api/usage");
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  show(el("p", { text: "Last 30 days: $" + total.toFixed(2) }), el("table", {}, el("thead", {}, el("tr", {}, ...["Day","Person","Machine","Repo","Requests","Cost"].map((h) => el("th", { text: h })))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, el("td", { text: r.day }), el("td", { text: r.member }), el("td", { text: r.machine }), el("td", { text: r.repo || "–" }), el("td", { class: "n", text: String(r.requests) }), el("td", { class: "n", text: "$" + r.cost.toFixed(2) }))))));
}
signIn();
</script>
</body>
</html>
`;
