/**
 * The team dashboard: one page, no build step. It asks for an admin token, keeps it for the tab only
 * (sessionStorage), and reads /api/dashboard. Everything it shows is set with textContent, never as HTML.
 */
export const DASHBOARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grenier team</title>
<style>
  :root { --bg: #fbfaf7; --fg: #1d1b16; --muted: #6b665c; --line: #e4e0d6; --accent: #8a4b14; --panel: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16150f; --fg: #ece8dd; --muted: #a39d8f; --line: #2f2c24; --accent: #e0a463; --panel: #1e1c16; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 32px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  p { color: var(--muted); margin: 0 0 16px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .tile b { display: block; font-size: 24px; font-variant-numeric: tabular-nums; }
  .tile span { color: var(--muted); font-size: 13px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  th, td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 0; }
  button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--fg); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  form { display: flex; gap: 8px; flex-wrap: wrap; }
  input { font: inherit; flex: 1 1 280px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--fg); }
  .error { color: #b42318; }
  [hidden] { display: none; }
</style>
</head>
<body>
<main>
  <h1>Grenier team</h1>
  <p>Usage, cache hits and savings across the team. Nothing here holds code, prompts or keys.</p>
  <form id="login">
    <label for="token" hidden>Admin token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Admin token (gt_…)" required>
    <button type="submit">Open</button>
  </form>
  <p id="message" class="error" role="alert"></p>
  <section id="board" hidden>
    <div class="tiles" id="tiles"></div>
    <h2>Members</h2>
    <div class="scroll"><table id="members"><thead><tr><th>Member</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody></tbody></table></div>
    <h2>Usage, last 30 days</h2>
    <div class="scroll"><table id="usage"><thead><tr><th>Day</th><th>Member</th><th class="n">Requests</th><th class="n">Tokens</th><th class="n">Prompt cache</th><th class="n">Answers reused</th><th class="n">Cost</th><th class="n">Saved</th></tr></thead><tbody></tbody></table></div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  const tokens = (n) => Number(n || 0).toLocaleString("en");
  const percent = (n) => Math.round(n * 100) + "%";

  function cell(row, text, numeric) {
    const td = document.createElement("td");
    td.textContent = text;
    if (numeric) td.className = "n";
    row.appendChild(td);
    return td;
  }

  async function api(path, init) {
    const response = await fetch(path, { ...init, headers: { authorization: "Bearer " + sessionStorage.getItem("grenier-token") } });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "HTTP " + response.status);
    return response.json();
  }

  async function load() {
    $("message").textContent = "";
    let data;
    try {
      data = await api("/api/dashboard");
    } catch (error) {
      $("message").textContent = error.message;
      $("board").hidden = true;
      return;
    }
    $("board").hidden = false;
    const sum = (key) => data.usage.reduce((total, row) => total + (row[key] || 0), 0);
    const input = sum("inputTokens") + sum("cacheWriteTokens") + sum("cacheReadTokens");
    const tiles = [
      [money(data.today.total), "spent today"],
      [money(sum("cost")), "spent in 30 days"],
      [money(sum("saved")), "saved by the prompt cache"],
      [input ? percent(sum("cacheReadTokens") / input) : "–", "of input from the prompt cache"],
      [tokens(sum("answerHits")), "answers reused"],
      [tokens(data.answers), "answers shared"],
    ];
    $("tiles").replaceChildren(...tiles.map(([value, label]) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      const b = document.createElement("b");
      b.textContent = value;
      const span = document.createElement("span");
      span.textContent = label;
      tile.append(b, span);
      return tile;
    }));

    const members = $("members").tBodies[0];
    members.replaceChildren();
    for (const member of data.members) {
      const row = members.insertRow();
      cell(row, member.name);
      cell(row, member.role);
      cell(row, member.revokedAt ? "revoked" : "active");
      const actions = cell(row, "");
      if (!member.revokedAt) {
        const button = document.createElement("button");
        button.textContent = "Revoke";
        button.addEventListener("click", async () => {
          if (!confirm("Revoke " + member.name + "'s token? Their next call gets 401.")) return;
          try { await api("/api/members/" + encodeURIComponent(member.name) + "/revoke", { method: "POST" }); } catch (error) { $("message").textContent = error.message; }
          load();
        });
        actions.appendChild(button);
      }
    }

    const usage = $("usage").tBodies[0];
    usage.replaceChildren();
    for (const entry of data.usage) {
      const row = usage.insertRow();
      const all = entry.inputTokens + entry.cacheWriteTokens + entry.cacheReadTokens;
      cell(row, entry.day);
      cell(row, entry.member);
      cell(row, tokens(entry.requests), true);
      cell(row, tokens(all + entry.outputTokens), true);
      cell(row, all ? percent(entry.cacheReadTokens / all) : "–", true);
      cell(row, tokens(entry.answerHits), true);
      cell(row, money(entry.cost), true);
      cell(row, money(entry.saved), true);
    }
  }

  $("login").addEventListener("submit", (event) => {
    event.preventDefault();
    sessionStorage.setItem("grenier-token", $("token").value.trim());
    $("token").value = "";
    load();
  });
  if (sessionStorage.getItem("grenier-token")) load();
</script>
</body>
</html>
`;
