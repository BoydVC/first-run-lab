import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runUrl, serveStatic } from "../src/engine.js";
import { launchBrowser } from "../src/observe.js";
import { BUILTIN_PERSONAS } from "../src/personas.js";
import { renderHistory, renderReport, renderStatechart } from "../src/report.js";
import { SESSION_TABLE } from "../src/statechart.generated.js";
import { TRANSITION_TABLE } from "../src/statechart.js";
import { startDashboard } from "../src/serve.js";
import { preReport } from "../src/statechart.js";
import { SESSION_STATES, type Persona, type Run, type SessionState } from "../src/types.js";

const persona = (id: string): Persona => {
  const found = BUILTIN_PERSONAS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};

let browser: Browser;

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser.close();
});

async function open(html: string, personas: readonly Persona[]): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "frl-fix-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "index.html"), html);
  const server = await serveStatic(root);
  try {
    return await runUrl(new URL("index.html", server.url).href, { browser, kind: "form", personas });
  } finally {
    await server.close();
  }
}

it("the engine transition table is the TLA+ session table", () => {
  const fromEngine: { from: string; to: string; why: string }[] = [];
  for (const from of SESSION_STATES) {
    const row = TRANSITION_TABLE[from] as Partial<Record<SessionState, string>>;
    for (const to of Object.keys(row) as SessionState[]) {
      const why = row[to];
      if (why) fromEngine.push({ from, to, why });
    }
  }
  expect(fromEngine).toEqual(SESSION_TABLE.map((edge) => ({ from: edge.from, to: edge.to, why: edge.why })));
});

it("links inside a closed details element are not visible controls", async () => {
  const html = readFileSync(join(import.meta.dirname, "..", "fixtures", "collapsed-links.html"), "utf8");
  const run = await open(html, [persona("keyboard"), persona("screenreader"), persona("phone")]);
  const kinds = new Set(run.hotspots.flatMap((hotspot) => hotspot.kinds));
  expect(kinds.has("unnamed_control")).toBe(false);
  expect(kinds.has("unreachable_by_keyboard")).toBe(false);
  expect(run.hotspots.map((hotspot) => hotspot.control)).not.toContain("Example source one");
});

it("keyboard tabs until focus wraps on a page with extra tab stops", async () => {
  const html = readFileSync(join(import.meta.dirname, "..", "fixtures", "manystops.html"), "utf8");
  const run = await open(html, [persona("keyboard")]);
  const missed = run.hotspots
    .filter((hotspot) => hotspot.kinds.includes("unreachable_by_keyboard"))
    .map((hotspot) => hotspot.control);
  expect(missed).not.toContain("Last example link");
  expect(missed).not.toContain("Start demo");
  expect(preReport(run.sessions[0]!)).not.toBe("crashed");
});

it("a form that re-draws its fields is a major finding, not a crash", async () => {
  const html = readFileSync(join(import.meta.dirname, "..", "fixtures", "redraw.html"), "utf8");
  const run = await open(html, [persona("skimmer")]);
  expect(preReport(run.sessions[0]!)).not.toBe("crashed");
  expect(run.verdict.kind).toBe("scored");
  const hit = run.hotspots.find((hotspot) => hotspot.kinds.includes("form_redraws_while_typing"));
  expect(hit?.severity).toBe("major");
});

it("a connection reset, a refused port, and a stalled link are dead links", async () => {
  const page = `<!doctype html><meta charset="utf-8"><title>Downloads</title>
<body><main><h1>Downloads</h1>
<p><a href="reset.pdf">Get the PDF</a></p>
<p><a href="http://127.0.0.1:1/nope">Closed port</a></p>
<p><a href="slow.bin">Slow file</a></p>
</main>`;
  const server = createServer((req, res) => {
    const url = req.url || "/";
    if (url.includes("reset")) {
      req.socket.destroy();
      return;
    }
    if (url.includes("slow")) return;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const run = await runUrl(`http://127.0.0.1:${port}/`, {
      browser,
      kind: "form",
      personas: [persona("curious")],
    });
    expect(preReport(run.sessions[0]!)).not.toBe("crashed");
    expect(run.verdict.kind).toBe("scored");
    const dead = run.hotspots.filter((hotspot) => hotspot.kinds.includes("dead_link")).map((hotspot) => hotspot.control);
    expect(dead).toEqual(expect.arrayContaining(["Get the PDF", "Closed port", "Slow file"]));
    for (const hotspot of run.hotspots.filter((item) => item.kinds.includes("dead_link"))) {
      expect(hotspot.severity).toBe("major");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("the report and dashboard use the experience shell", () => {
  const history = renderHistory([]);
  expect(history).toContain("Runs");
  expect(history).toContain("Leaderboard");
  expect(history).toContain("Statechart");
  expect(history).toContain("min-height: 44px");
  const chart = renderStatechart();
  expect(chart).toContain("queued");
  expect(chart).toContain(">start<");
  expect(chart).toContain("reported");
  const report = renderReport({
    schema: 1,
    id: "demo",
    url: "http://127.0.0.1:9/signup.html",
    startedAt: "2026-01-15T09:30:00.000Z",
    kind: "form",
    sessions: [],
    hotspots: [],
    verdict: { kind: "inconclusive", crashed: [persona("skimmer").id] },
    blocked: [],
  });
  expect(report).toContain("dial inconclusive");
  expect(report).not.toMatch(/score \d/);
});

it("the dashboard fits a 375px screen and tabs through its sections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frl-dash-"));
  const dash = await startDashboard({ port: 0, runsDir: dir });
  const page = await browser.newPage({ viewport: { width: 375, height: 740 } });
  try {
    await page.goto(`http://127.0.0.1:${dash.port}/`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide).toBeLessThanOrEqual(4);
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => (document.activeElement?.textContent || "").trim());
      if (label) seen.push(label);
    }
    expect(seen).toContain("Runs");
    expect(seen).toContain("Leaderboard");
    expect(seen).toContain("Statechart");
  } finally {
    await page.close();
    await dash.close();
  }
});
