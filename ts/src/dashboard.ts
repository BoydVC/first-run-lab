import { statechartLines, statechartMermaid } from "./statechart.js";
import type { Run } from "./types.js";

export function dashboardHtml(runs: readonly Run[]): string {
  const chart = statechartLines()
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  const cards = runs
    .map((run, index) => {
      const score = run.verdict.kind === "scored" ? String(run.verdict.score) : run.verdict.kind;
      const rows = run.hotspots
        .map(
          (hotspot) =>
            `<tr><td>${hotspot.id}</td><td>${hotspot.severity}</td><td>${escapeHtml(String(hotspot.control))}</td><td>${hotspot.kinds.join(", ")}</td><td>${hotspot.personas.join(", ")}</td></tr>`,
        )
        .join("");
      return `<section data-run="${index}"><h2>${escapeHtml(run.url)}</h2><p class="score">${score}</p><table>${rows}</table></section>`;
    })
    .join("");
  const scores = runs.map((run) => (run.verdict.kind === "scored" ? run.verdict.score : "null")).join(",");
  return `<!doctype html><meta charset="utf-8"><title>First-Run Lab</title>
<style>
  body{font-family:sans-serif;margin:24px;background:#f6f4ef;color:#1c1915}
  table{border-collapse:collapse;width:100%} td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}
  .score{font-size:48px;margin:0}
  section{display:none} section.on{display:block}
</style>
<h1>First-Run Lab</h1>
<p>Runs on this machine. Statechart from the same transition table as the engine.</p>
<input id="slider" type="range" min="0" max="${Math.max(0, runs.length - 1)}" value="0">
<div id="runs">${cards}</div>
<h2>Statechart</h2>
<ul>${chart}</ul>
<pre>${escapeHtml(statechartMermaid())}</pre>
<script>
const scores = [${scores}];
const sections = [...document.querySelectorAll("section")];
const slider = document.getElementById("slider");
function show(i){ sections.forEach((s, n) => s.classList.toggle("on", n === i)); }
slider.addEventListener("input", () => show(Number(slider.value)));
show(0);
void scores;
</script>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}
