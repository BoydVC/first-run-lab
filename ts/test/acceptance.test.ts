import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { formatTerminal, headline } from "../src/copy.js";
import { executeRun, TAB_CAP } from "../src/engine.js";
import { renderReport } from "../src/report.js";
import { startDashboard } from "../src/serve.js";
import { representedFindings, findingCount } from "../src/score.js";
import { preReport } from "../src/state.js";
import { launch, staticServer, sweepPorts } from "../src/sweep.js";
import type { Run } from "../src/types.js";

const root = join(import.meta.dirname, "..", "..");
let signupScore = -1;
let signupIds: string[] = [];
const cli = join(import.meta.dirname, "..", "dist", "cli.js");
let browser: Browser;
let started = 0;

before(async () => {
  started = Date.now();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); });

async function site(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "frl-site-"));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  const srv = await staticServer(dir);
  return { dir, port: srv.port, close: async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); }, url: (p = "index.html") => `http://127.0.0.1:${srv.port}/${p}` };
}

function kinds(run: Run): Set<string> {
  return new Set(run.hotspots.flatMap((h) => h.kinds));
}
function controls(run: Run): string[] {
  return run.hotspots.map((h) => h.control);
}

const FAST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font:16px system-ui;margin:16px}button{min-width:44px;min-height:44px;padding:12px 16px}:focus{outline:3px solid #1d4ed8;outline-offset:2px}</style>
</head><body><h1>Standings</h1><p id="msg" role="status"></p>
<button id="refresh" type="button">Refresh view</button>
<script>document.getElementById("refresh").onclick=()=>{document.getElementById("msg").textContent="Updated just now"}</script>
</body></html>`;

describe("acceptance", () => {
  it("AT1 AT2 AT3 AT5 signup is scored, Sign up is the top hotspot, skimmer gets stuck", async () => {
    const srv = await staticServer(join(root, "examples"));
    try {
      const out = mkdtempSync(join(tmpdir(), "frl-bad-"));
      const run = await executeRun({ url: `http://127.0.0.1:${srv.port}/signup.html`, out, browser, kind: "form", evidence: true, frames: false });
      assert.equal(run.verdict.kind, "scored");
      if (run.verdict.kind !== "scored") return;
      signupScore = run.verdict.score;
      signupIds = run.hotspots.map((h) => h.id);
      assert.ok(run.verdict.score <= 50);
      assert.ok(run.hotspots.length >= 6);
      const top = run.hotspots[0];
      assert.equal(top.control, "Sign up");
      assert.equal(top.severity, "blocker");
      assert.ok(top.personas.length >= 3);
      assert.ok(top.kinds.includes("silent_failure"));
      assert.ok(top.kinds.includes("unreachable_by_keyboard"));
      assert.ok(top.kinds.includes("fake_button"));
      const menu = run.hotspots.find((h) => h.control === "☰");
      assert.ok(menu);
      assert.deepEqual([...menu.kinds].sort(), ["tiny_tap_target", "unnamed_control"].sort());
      assert.equal(new Set(controls(run)).size, run.hotspots.length);
      const skimmer = run.sessions.find((s) => s.persona === "skimmer")!;
      assert.equal(preReport(skimmer), "stuck");
      assert.ok(skimmer.findings.some((f) => f.kind === "slow_or_no_confirmation"));
      assert.equal(representedFindings(run.hotspots), findingCount(run.sessions));
      const text = formatTerminal(run, join(out, "report.html"));
      assert.match(text, /Sign up tripped up \d of 5 first-time users/);
      assert.match(text, /report\s+\S+report\.html/);
      const html = readFileSync(join(out, "report.html"), "utf8");
      assert.match(html, /Sign up tripped up/);
      const shot = top.evidence.shot;
      assert.ok(shot);
      const buf = readFileSync(join(out, shot));
      assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      assert.ok(w < 500 && h < 300, `crop ${w}x${h} should be the control, not the page`);
      rmSync(out, { recursive: true, force: true });
    } finally { await srv.close(); }
  });

  it("AT4 AT14 fixed page scores 100 and a second signup run matches ids and score", async () => {
    const srv = await staticServer(join(root, "examples"));
    try {
      const fixed = await executeRun({ url: `http://127.0.0.1:${srv.port}/signup-fixed.html`, browser, kind: "form", evidence: false, write: false });
      assert.equal(fixed.verdict.kind, "scored");
      if (fixed.verdict.kind === "scored") assert.equal(fixed.verdict.score, 100);
      assert.ok(fixed.sessions.every((s) => preReport(s) === "done"));
      const again = await executeRun({ url: `http://127.0.0.1:${srv.port}/signup.html`, browser, kind: "form", evidence: false, write: false });
      assert.equal(again.verdict.kind, "scored");
      if (again.verdict.kind === "scored") assert.equal(again.verdict.score, signupScore);
      assert.deepEqual(again.hotspots.map((h) => h.id), signupIds);
      const gone = new Set(fixed.hotspots.map((h) => h.id));
      assert.ok(signupIds.every((id) => !gone.has(id)));
    } finally { await srv.close(); }
  });

  it("closed details and a collapsed accordion are not nameless controls", async () => {
    const html = `<!doctype html><meta charset="utf-8"><title>Fold</title>
<style>
  details:not([open]) > .fold { display: block !important; height: 0 !important; overflow: hidden !important; }
  #acc { height: 0; overflow: hidden; }
  button { min-width: 48px; min-height: 44px; }
</style>
<button type="button" id="shown-unnamed"></button>
<button type="button">Refresh view</button>
<details>
  <summary>Bakery notes</summary>
  <div class="fold"><button type="button" id="in-details" style="width:80px;height:40px"></button></div>
</details>
<button type="button" aria-expanded="false" aria-controls="acc">More treats</button>
<div id="acc"><button type="button" id="in-accordion" style="width:80px;height:40px"></button></div>`;
    const srv = await site({ "index.html": html });
    const page = await browser.newPage();
    try {
      await page.goto(srv.url());
      const v1 = await page.evaluate(`(() => {
        const vis = (e) => {
          const r = e.getBoundingClientRect();
          return !!(e.offsetParent || e.getClientRects().length) && r.width > 0 && r.height > 0
            && getComputedStyle(e).visibility !== "hidden"
            && !e.closest("[aria-hidden=true],[inert],dialog:not([open])")
            && !e.disabled;
        };
        return {
          details: vis(document.querySelector("#in-details")),
          accordion: vis(document.querySelector("#in-accordion")),
        };
      })()`) as { details: boolean; accordion: boolean };
      assert.equal(v1.details, true, "fixture must reproduce the v1 details bug");
      assert.equal(v1.accordion, true, "fixture must reproduce the v1 accordion bug");
      const run = await executeRun({ url: srv.url(), browser, kind: "form", evidence: false, write: false, personas: ["screenreader"] });
      const names = controls(run);
      assert.ok(names.includes("shown-unnamed"));
      assert.equal(names.includes("in-details"), false);
      assert.equal(names.includes("in-accordion"), false);
      assert.equal(kinds(run).has("unnamed_control"), true);
    } finally { await page.close(); await srv.close(); }
  });

  it("keyboard tabs until focus wraps, past the old control-count-plus-five cap", async () => {
    const pads = Array.from({ length: 12 }, (_, i) => `<div tabindex="0" id="pad${i}">pad ${i}</div>`).join("");
    const html = `<!doctype html><meta charset="utf-8"><title>Tabs</title>
<style>:focus{outline:3px solid #1d4ed8;outline-offset:2px}button{min-height:44px;min-width:44px}</style>
${pads}
<button type="button" id="save">Save</button>
<div id="ghost" onclick="void 0">Ghost</div>
<script>window.__tabs=0;document.addEventListener("keydown",e=>{if(e.key==="Tab")window.__tabs++},true)</script>`;
    const srv = await site({ "index.html": html });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(srv.url());
      const missed = await v1WouldMissSave(page);
      assert.equal(missed, true, "v1's control+5 cap must miss Save on this fixture");
      const run = await executeRun({ url: srv.url(), browser, kind: "form", evidence: false, write: false, personas: ["keyboard"] });
      const why = run.sessions[0].log.map((l) => l.why).join(" ");
      const tabs = Number(why.match(/(\d+) tabs/)?.[1] || 0);
      assert.ok(tabs > 2 + 5, `tabs ${tabs} should pass the v1 cap`);
      assert.ok(tabs <= TAB_CAP);
      const unreachable = run.sessions[0].findings.filter((f) => f.kind === "unreachable_by_keyboard").map((f) => f.control);
      assert.equal(unreachable.includes("Save"), false);
      assert.ok(unreachable.includes("Ghost"));
    } finally { await page.close(); await srv.close(); }
  });

  it("AT6 a thrown evaluate is inconclusive, never a score", async () => {
    const srv = await site({ "index.html": `<!doctype html><title>Boom</title><script>document.querySelectorAll=function(){throw new Error("injected evaluate error")}</script><button>Save</button>` });
    try {
      const run = await executeRun({ url: srv.url(), browser, kind: "form", evidence: false, write: false });
      assert.equal(run.verdict.kind, "inconclusive");
      if (run.verdict.kind === "inconclusive") assert.ok(run.verdict.crashed.length >= 1);
      const html = renderReport(run);
      assert.match(html, /class="dial inconclusive"/);
      assert.doesNotMatch(formatTerminal(run, ""), /score\s+\d/);
    } finally { await srv.close(); }
  });

  it("AT7 AT canvas toast focus: feedback is a change, not unchanged text", async () => {
    const silent = await site({ "index.html": `<!doctype html><button id="go" style="min-height:44px">Save</button><p id="m">Same</p><script>document.getElementById("go").onclick=()=>{}</script>` });
    const live = await site({ "index.html": `<!doctype html><button id="go" style="min-height:44px">Save</button><p id="m" role="alert"></p><script>document.getElementById("go").onclick=()=>{document.getElementById("m").textContent="Saved"}</script>` });
    const same = await site({ "index.html": `<!doctype html><p id="m">Same</p><button id="go" style="min-height:44px">Save</button><script>document.getElementById("go").onclick=()=>{/* unchanged identical text */}</script>` });
    try {
      const bad = await executeRun({ url: silent.url(), browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.ok(kinds(bad).has("silent_failure"));
      const good = await executeRun({ url: live.url(), browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.equal(kinds(good).has("silent_failure"), false);
      const unchanged = await executeRun({ url: same.url(), browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.ok(kinds(unchanged).has("silent_failure"));
    } finally { await silent.close(); await live.close(); await same.close(); }
  });

  it("canvas, toast, focus, role, covered, api, and external links match the v1.3 rules", async () => {
    const fix = join(root, "tests", "fixtures");
    const srv = await staticServer(fix);
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const canvas = await executeRun({ url: `${base}/o1/canvas.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.equal(kinds(canvas).has("silent_failure"), false);
      const toast = await executeRun({ url: `${base}/o1/toast.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.equal(kinds(toast).has("silent_failure"), false);
      const focus = await executeRun({ url: `${base}/o1/focus.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.equal(kinds(focus).has("silent_failure"), false);
      const role = await executeRun({ url: `${base}/o1/rolebtn.html`, browser, kind: "dashboard", evidence: false, write: false, personas: ["screenreader"] });
      assert.equal(kinds(role).has("unnamed_control"), false);
      const covered = await executeRun({ url: `${base}/o1/covered.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.equal(covered.verdict.kind, "scored");
      assert.ok(kinds(covered).has("unclickable_cta"));
      const missing = await executeRun({ url: `${base}/o1/missing.html`, browser, evidence: false, write: false });
      assert.equal(missing.verdict.kind, "unreachable");
      const needs = await executeRun({ url: `${base}/o1/needsapi.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      assert.equal(needs.verdict.kind, "needs_backend");
      const o1 = await staticServer(join(fix, "o1"));
      let partial: Run;
      try {
        partial = await executeRun({ url: `http://127.0.0.1:${o1.port}/partialapi.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      } finally { await o1.close(); }
      assert.equal(partial.verdict.kind, "scored");
      assert.ok(kinds(partial).has("broken_api"));
      const ext = await executeRun({ url: `${base}/o1/extlinks.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer", "curious"] });
      const dead = ext.hotspots.filter((h) => h.kinds.includes("dead_link")).map((h) => h.control);
      assert.deepEqual(dead, ["Local page"]);
      assert.equal(kinds(ext).has("silent_failure"), false);
      const form = await executeRun({ url: `${base}/o2/dash.html`, browser, kind: "form", evidence: false, write: false, personas: ["skimmer"] });
      const dash = await executeRun({ url: `${base}/o2/dash.html`, browser, kind: "dashboard", evidence: false, write: false, personas: ["skimmer"] });
      const auto = await executeRun({ url: `${base}/o2/dash.html`, browser, kind: "auto", evidence: false, write: false, personas: ["skimmer"] });
      const sev = (r: Run) => r.hotspots.filter((h) => h.kinds.includes("no_clear_cta")).map((h) => h.severity);
      assert.deepEqual(sev(form), ["major"]);
      assert.deepEqual(sev(dash), ["minor"]);
      assert.equal(auto.kind, "dashboard");
    } finally { await srv.close(); }
  });

  it("AT8 gate exits 0, 1, and 2", async () => {
    const good = await site({ "index.html": FAST });
    const bad = await staticServer(join(root, "examples"));
    const crash = await site({ "index.html": `<!doctype html><script>document.querySelectorAll=function(){throw new Error("injected")}</script><p>Hi</p>` });
    try {
      assert.equal(await gate(good.url(), 80), 0);
      assert.equal(await gate(`http://127.0.0.1:${bad.port}/signup.html`, 80), 1);
      assert.equal(await gate(crash.url(), 80), 2);
    } finally { await good.close(); await bad.close(); await crash.close(); }
  });

  it("AT9 refuses a remote URL before launch and aborts a cross-origin image", async () => {
    const r = spawnSync(process.execPath, [cli, "run", "https://example.com"], { encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /refusing/);
    const srv = await site({ "index.html": `<!doctype html><title>Img</title><h1>Board</h1><img src="https://example.com/pixel.png" alt=""><p>Local only</p>` });
    try {
      const run = await executeRun({ url: srv.url(), browser, kind: "dashboard", evidence: false, write: false, personas: ["skimmer"] });
      assert.ok(run.blocked.some((u) => u.includes("example.com")));
    } finally { await srv.close(); }
  });

  it("AT10 privacy scan blocks a.b@example.com and writes nothing", async () => {
    const srv = await site({ "index.html": `<!doctype html><h1>Write a.b@example.com</h1><button style="min-height:44px">Refresh view</button>` });
    const out = join(tmpdir(), `frl-pii-${Date.now()}`);
    try {
      await assert.rejects(
        () => executeRun({ url: srv.url(), out, browser, kind: "dashboard", evidence: false, personas: ["skimmer"] }),
        (e: unknown) => e instanceof Error && "exitCode" in e && (e as { exitCode: number }).exitCode === 3,
      );
      assert.equal(existsSync(out), false);
    } finally { await srv.close(); }
  });

  it("AT11 sweep orders scored apps ahead of inconclusive ones", async () => {
    const hi = await site({ "index.html": FAST });
    const lo = await site({ "index.html": `<!doctype html><script>document.querySelectorAll=function(){throw new Error("x")}</script><p>Nope</p>` });
    try {
      const board = await sweepPorts([hi.port, lo.port], { browser });
      const rows = Object.entries(board).sort((a, b) => (a[1].score == null ? 1 : b[1].score == null ? -1 : b[1].score - a[1].score));
      assert.equal(rows[0][1].score != null, true);
      assert.equal(rows[1][1].verdict, "inconclusive");
      assert.ok((rows[0][1].score ?? 0) >= (rows[1][1].score ?? -1));
    } finally { await hi.close(); await lo.close(); }
  });

  it("AT12 a tablet-kid JSON persona runs without a code change", async () => {
    const srv = await staticServer(join(root, "examples"));
    try {
      const run = await executeRun({
        url: `http://127.0.0.1:${srv.port}/signup.html`,
        browser, kind: "form", evidence: false, write: false, personas: ["tablet-kid"],
      });
      assert.equal(run.sessions[0].persona, "tablet-kid");
      assert.notEqual(preReport(run.sessions[0]), "crashed");
      assert.ok(run.sessions[0].findings.some((f) => f.kind === "tiny_tap_target" || f.kind === "unnamed_control"));
    } finally { await srv.close(); }
  });

  it("many controls, a help dialog, and redaction stay scored", async () => {
    const prev = process.env.FRL_REDACT;
    process.env.FRL_REDACT = "B7";
    const srv = await staticServer(join(root, "tests", "fixtures", "sweepfix"));
    try {
      const run = await executeRun({ url: `http://127.0.0.1:${srv.port}/many.html`, browser, kind: "auto", evidence: false, write: false });
      assert.equal(run.verdict.kind, "scored");
      const k = kinds(run);
      assert.equal(k.has("unreachable_by_keyboard"), false);
      assert.equal(k.has("no_clear_cta"), false);
      assert.equal(controls(run).includes("Hidden"), false);
      assert.equal(JSON.stringify(run).includes("B7"), false);
    } finally {
      if (prev === undefined) delete process.env.FRL_REDACT; else process.env.FRL_REDACT = prev;
      await srv.close();
    }
  });

  it("offline start hint launches the demo server", async () => {
    const dir = join(root, "tests", "fixtures", "o4", "pyapp");
    const text = await launch(dir, 8877, async (url) => {
      const res = await fetch(url);
      return await res.text();
    });
    assert.match(text, /Sample Team/);
  });

  it("the dashboard scores at least 90 and works at 375px by keyboard", async () => {
    const dash = await startDashboard({ port: 0, runsDir: mkdtempSync(join(tmpdir(), "frl-runs-")) });
    const page = await browser.newPage({ viewport: { width: 375, height: 740 } });
    try {
      for (const path of ["/", "/leaderboard", "/statechart"]) {
        await page.goto(`http://127.0.0.1:${dash.port}${path}`);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(wide <= 4, `${path} overflows by ${wide}px at 375`);
        const seen: string[] = [];
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Tab");
          const label = await page.evaluate(() => (document.activeElement?.textContent || "").trim());
          if (label) seen.push(label);
        }
        assert.ok(seen.includes("Runs"), `${path} tab order ${seen.join("|")}`);
        assert.ok(seen.includes("Leaderboard"));
        assert.ok(seen.includes("Statechart"));
      }
      const run = await executeRun({ url: `http://127.0.0.1:${dash.port}/`, browser, kind: "auto", evidence: false, write: false });
      assert.equal(run.verdict.kind, "scored");
      if (run.verdict.kind === "scored") assert.ok(run.verdict.score >= 90, `dogfood ${run.verdict.score}`);
      assert.equal(kinds(run).has("horizontal_scroll"), false);
      assert.equal(kinds(run).has("unreachable_by_keyboard"), false);
      assert.equal(kinds(run).has("invisible_focus"), false);
    } finally { await page.close(); await dash.close(); }
  });

  it("AT15 the fixture suite stays under 60s", () => {
    assert.ok(Date.now() - started < 60_000, `suite took ${Date.now() - started}ms`);
  });
});

async function gate(url: string, min: number): Promise<number> {
  const run = await executeRun({ url, browser, kind: "auto", evidence: false, write: false });
  if (run.verdict.kind !== "scored") return 2;
  return run.verdict.score >= min ? 0 : 1;
}

async function v1WouldMissSave(page: Page): Promise<boolean> {
  const n = await page.evaluate(() => document.querySelectorAll("a,button,input,select,textarea,[onclick],[role=button]").length);
  const cap = n + 5;
  let sawSave = false;
  for (let i = 0; i < cap; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.id || "");
    if (id === "save") sawSave = true;
  }
  return !sawSave;
}
