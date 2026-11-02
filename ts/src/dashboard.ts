import { SESSION_TABLE, RUN_TABLE } from "./statechart.generated.ts";
import type { Run } from "./types.ts";

export function dashboardHtml(runs: { name: string; run: Run }[]): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const edges = SESSION_TABLE.map((t) => `<li><code>${esc(t.from)}</code> —${esc(t.why)}→ <code>${esc(t.to)}</code></li>`).join("");
  const runEdges = RUN_TABLE.map((t) => `<li><code>${esc(t.from)}</code> —${esc(t.why)}→ <code>${esc(t.to)}</code></li>`).join("");
  const cards = runs.map(({ name, run }) => {
    const score = run.verdict.kind === "scored" ? String(run.verdict.score) : run.verdict.kind;
    const rows = run.hotspots.map((h) => `<tr><td>${esc(h.id)}</td><td>${esc(h.severity)}</td><td>${esc(String(h.control))}</td><td>${esc(h.kinds.join(", "))}</td><td>${esc(h.personas.join(", "))}</td></tr>`).join("");
    return `<article data-score="${esc(score)}"><h2>${esc(name)} — ${esc(score)}</h2><table class=hotspots><tr><th>id</th><th>severity</th><th>control</th><th>kinds</th><th>personas</th></tr>${rows}</table></article>`;
  }).join("");
  const a = runs[0]?.run.verdict.kind === "scored" ? runs[0].run.verdict.score : "";
  const b = runs[1]?.run.verdict.kind === "scored" ? runs[1].run.verdict.score : "";
  return `<!doctype html><meta charset=utf-8><title>First-Run Lab</title>
<style>
  body{font-family:system-ui,sans-serif;margin:24px;background:#0f172a;color:#e2e8f0}
  code{color:#fbbf24} table{border-collapse:collapse;width:100%} td,th{padding:4px 8px;border-bottom:1px solid #334155;text-align:left}
  .slider{position:relative;height:88px;background:#1e293b;border-radius:12px;overflow:hidden;margin:16px 0}
  .slider .after{position:absolute;inset:0;width:50%;overflow:hidden;background:#14532d}
  input[type=range]{width:100%}
</style>
<h1>First-Run Lab</h1>
<section id=statechart><h2>Session statechart</h2><ul>${edges}</ul><h3>Run</h3><ul>${runEdges}</ul></section>
<section id=compare><h2>Before / after</h2>
<div class=slider><div class=after id=after></div></div>
<label>before ${esc(String(a))} <input id=range type=range min=0 max=100 value=50> after ${esc(String(b))}</label>
</section>
<section id=runs>${cards}</section>
<script>
const range = document.getElementById('range');
const after = document.getElementById('after');
range?.addEventListener('input', () => { after.style.width = range.value + '%'; });
</script>`;
}
