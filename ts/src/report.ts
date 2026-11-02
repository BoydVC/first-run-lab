import { displayKinds, experienceSentence, FIX, headline, KIND_LABEL, primaryKind } from "./copy.js";
import { TRANSITIONS } from "./state.js";
import type { Hotspot, Run, SessionState } from "./types.js";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root { --ink:#1c1917; --paper:#f6f1e7; --card:#fffdf8; --line:#e7e0d2; --blocker:#9f1239; --major:#9a3412; --minor:#3f6212; --grey:#78716c; --focus:#1d4ed8; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--paper); color: var(--ink); }
body { font: 16px/1.45 system-ui, "Segoe UI", sans-serif; }
:focus { outline: 3px solid var(--focus); outline-offset: 3px; }
a { color: inherit; }
.wrap { max-width: 880px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-family: Georgia, "Iowan Old Style", Palatino, serif; font-size: 1.85rem; line-height: 1.15; margin: 0 0 8px; }
.meta { color: #44403c; margin: 0 0 12px; overflow-wrap: anywhere; }
.dial-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0 18px; }
.dial { width: 128px; }
.dial svg { width: 128px; height: 128px; display: block; }
.hotspot { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 14px 12px; margin: 12px 0; }
.hotspot h2 { font-size: 1.25rem; margin: 4px 0; overflow-wrap: anywhere; }
.who { margin: 0; color: #44403c; }
.experience { font-size: 1.05rem; margin: 10px 0; }
.fixes { margin: 8px 0 0; padding-left: 1.1rem; }
.fixes li { margin: 4px 0; }
.sev { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.sev.blocker { color: var(--blocker); }
.sev.major { color: var(--major); }
.sev.minor { color: var(--minor); }
.shot { margin: 12px 0 0; }
.shot img { max-width: 100%; height: auto; border-radius: 10px; background: white; }
nav[aria-label="Sections"] { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 16px; }
nav[aria-label="Sections"] a { display: inline-block; min-height: 44px; padding: 10px 12px; text-decoration: none; border-bottom: 2px solid transparent; }
nav[aria-label="Sections"] a[aria-current="page"] { border-bottom-color: var(--ink); }
.skip { display: inline-block; min-height: 44px; padding: 10px 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.bar { height: 10px; border-radius: 6px; background: var(--line); }
.bar > span { display: block; height: 10px; border-radius: 6px; }
.edges { list-style: none; padding: 0; margin: 0; }
.edges li { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--line); }
.edges .from, .edges .to { font-weight: 650; }
.edges .why { color: #57534e; }
.compare { display: grid; gap: 12px; }
.compare .panel { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
input[type="range"] { width: 100%; min-height: 44px; }
.chart { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.chart span { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 8px 12px; }
@media (max-width: 420px) {
  h1 { font-size: 1.45rem; }
  .dial, .dial svg { width: 104px; height: 104px; }
}
`;

function dial(run: Run): string {
  if (run.verdict.kind !== "scored") {
    return `<div class="dial inconclusive" role="img" aria-label="Inconclusive">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="48" fill="none" stroke="#d6d3d1" stroke-width="10"/>
        <circle class="fg" cx="60" cy="60" r="48" fill="none" stroke="#a8a29e" stroke-width="10" stroke-dasharray="0 302"/>
        <text x="60" y="64" text-anchor="middle" font-size="13" font-family="Georgia, serif" fill="#57534e">Inconclusive</text>
      </svg>
    </div>`;
  }
  const score = run.verdict.score;
  const color = score >= 90 ? "#3f6212" : score >= 70 ? "#b45309" : "#9f1239";
  const circ = 2 * Math.PI * 48;
  const dash = (score / 100) * circ;
  return `<div class="dial scored" role="img" aria-label="Score ${score} out of 100">
    <svg viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="48" fill="none" stroke="#e7e0d2" stroke-width="10"/>
      <circle class="fg" cx="60" cy="60" r="48" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 60 60)"/>
      <text x="60" y="68" text-anchor="middle" font-size="32" font-family="Georgia, serif" fill="#1c1917">${score}</text>
    </svg>
  </div>`;
}

function hotspotCard(h: Hotspot, total: number, n: number): string {
  const kinds = displayKinds(h.kinds);
  const lead = primaryKind(h.kinds);
  const img = h.evidence.shot
    ? `<figure class="shot"><img alt="${esc(h.control)} highlighted" src="${esc(h.evidence.shot)}"></figure>`
    : "";
  const fixes = kinds
    .map((k) => `<li><strong>${esc(KIND_LABEL[k])}.</strong> ${esc(FIX[k])}</li>`)
    .join("");
  return `<article class="hotspot">
    <p class="sev ${h.severity}">${n}. ${h.severity}</p>
    <h2>${esc(h.control === "page" ? "This page" : /[A-Za-z0-9]/.test(h.control) ? h.control : `${h.control} (icon button)`)}</h2>
    <p class="who">${h.personas.length} of ${total} first-time users · ${esc(h.personas.join(", "))}</p>
    <p class="experience">${esc(experienceSentence(h.control, lead))}</p>
    <ul class="fixes">${fixes}</ul>
    ${img}
  </article>`;
}

export function renderReport(run: Run): string {
  const total = run.sessions.length;
  const cards = run.hotspots.map((h, i) => hotspotCard(h, total, i + 1)).join("");
  const banner =
    run.verdict.kind === "scored"
      ? `${run.hotspots.length} hotspots · ${run.kind}`
      : run.verdict.kind === "inconclusive"
        ? "No score. A crashed run is not a pass."
        : esc(run.verdict.detail);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>First-Run Lab</title><style>${CSS}</style></head><body class="verdict-${run.verdict.kind}">
<div class="wrap">
  <p class="sev">First-Run Lab</p>
  <h1>${esc(headline(run))}</h1>
  <div class="dial-row">${dial(run)}<p class="meta">${esc(banner)}<br>${esc(run.url)}</p></div>
  ${cards || "<p>No hotspots.</p>"}
</div></body></html>`;
}

export interface BoardRow {
  name: string;
  score: number | null;
  verdict: string;
  kinds: string[];
}

export function sortBoard(rows: BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    if (a.score == null && b.score == null) return a.name.localeCompare(b.name);
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score || a.name.localeCompare(b.name);
  });
}

function shell(title: string, current: string, body: string): string {
  const link = (href: string, label: string) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="wrap">
  <a class="skip" href="#main">Skip to content</a>
  <a class="brand" href="/">First-Run Lab</a>
  <nav aria-label="Sections">
    ${link("/", "Runs")}
    ${link("/leaderboard", "Leaderboard")}
    ${link("/statechart", "Statechart")}
  </nav>
  <main id="main">${body}</main>
</div></body></html>`;
}

export interface DashRun {
  id: string;
  url: string;
  startedAt: string;
  label: string;
  href: string | null;
}

export function renderHistory(runs: DashRun[]): string {
  const list = runs.length
    ? `<ul class="edges">${runs
        .map((r) => {
          const name = r.href ? `<a href="${esc(r.href)}">${esc(r.id)}</a>` : esc(r.id);
          return `<li><span class="from">${name}</span><span class="why">${esc(r.label)}</span><span class="to">${esc(r.url)}</span></li>`;
        })
        .join("")}</ul>`
    : `<p class="empty">No runs yet.</p>`;
  return shell(
    "Runs",
    "/",
    `<h1>Run history</h1><p>Five synthetic first-time users walk a local app. Finished runs land here with a score and hotspots.</p>${list}`,
  );
}

export function renderLeaderboard(rows: BoardRow[]): string {
  const sorted = sortBoard(rows);
  const body = sorted.length
    ? `<table><thead><tr><th>#</th><th>App</th><th>Score</th><th>Findings</th></tr></thead><tbody>${sorted
        .map((r, i) => {
          const score = r.score == null ? "—" : String(r.score);
          const color = r.score == null ? "#a8a29e" : r.score >= 90 ? "#3f6212" : r.score >= 70 ? "#b45309" : "#9f1239";
          const bar = r.score == null ? "" : `<div class="bar"><span style="width:${r.score}%;background:${color}"></span></div>`;
          const kinds = r.kinds.length ? r.kinds.join(", ") : r.verdict;
          return `<tr><td>${r.score == null ? "–" : i + 1}</td><td>${esc(r.name)}</td><td>${score}${bar}</td><td>${esc(kinds)}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : `<p>No sweep yet. Run first-run-lab sweep against local ports, then reload this page.</p>`;
  const scored = sorted.filter((r) => r.score != null).map((r) => r.score!);
  const med = scored.length ? [...scored].sort((a, b) => a - b)[Math.floor(scored.length / 2)] : "—";
  return shell(
    "Leaderboard",
    "/leaderboard",
    `<h1>Fleet leaderboard</h1><p>${sorted.length} apps · ${scored.length} scored · median ${med}</p>${body}`,
  );
}

export function renderStatechart(): string {
  const edges = (Object.keys(TRANSITIONS) as SessionState[]).flatMap((from) =>
    TRANSITIONS[from].map((e) => ({ from, to: e.to, why: e.why })),
  );
  const states = (Object.keys(TRANSITIONS) as SessionState[])
    .map((s) => `<span>${esc(s)}</span>`)
    .join("");
  const rows = edges
    .map((e) => `<li><span class="from">${esc(e.from)}</span><span class="why">${esc(e.why)}</span><span class="to">${esc(e.to)}</span></li>`)
    .join("");
  return shell(
    "Statechart",
    "/statechart",
    `<h1>Session statechart</h1>
     <p>Every persona walks this chart. Reported is the only sink. A crashed session makes the whole run inconclusive.</p>
     <div class="chart" aria-hidden="true">${states}</div>
     <ul class="edges">${rows}</ul>`,
  );
}

export function renderDiff(before: Run, after: Run): string {
  const a = before.verdict.kind === "scored" ? String(before.verdict.score) : before.verdict.kind;
  const b = after.verdict.kind === "scored" ? String(after.verdict.score) : after.verdict.kind;
  const ids = new Set(after.hotspots.map((h) => h.id));
  const resolved = before.hotspots.filter((h) => !ids.has(h.id));
  const added = after.hotspots.filter((h) => !before.hotspots.some((x) => x.id === h.id));
  const list = (hs: Hotspot[]) =>
    hs.length
      ? `<ul class="fixes">${hs.map((h) => `<li>${esc(h.id)} ${esc(h.severity)} ${esc(h.control)}</li>`).join("")}</ul>`
      : "<p>None.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Before and after</title><style>${CSS}</style></head><body>
<div class="wrap">
  <h1>Before and after</h1>
  <label for="cmp">Show the run before or after the fix</label>
  <input id="cmp" type="range" min="0" max="100" value="50" aria-valuemin="0" aria-valuemax="100">
  <div class="compare">
    <div class="panel before" id="panel-before"><h2>Before · ${esc(a)}</h2><p>${esc(headline(before))}</p>${list(before.hotspots)}</div>
    <div class="panel after" id="panel-after"><h2>After · ${esc(b)}</h2><p>${esc(headline(after))}</p>${list(after.hotspots)}</div>
  </div>
  <h2>Resolved</h2>${list(resolved)}
  <h2>New</h2>${list(added)}
</div>
<script>
  const range = document.getElementById("cmp");
  const after = document.getElementById("panel-after");
  const before = document.getElementById("panel-before");
  function paint() {
    const v = Number(range.value);
    after.style.opacity = String(v / 100);
    before.style.opacity = String(1 - v / 100);
    range.setAttribute("aria-valuenow", String(v));
  }
  range.addEventListener("input", paint);
  paint();
</script>
</body></html>`;
}
