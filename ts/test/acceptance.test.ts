import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { personaFromJson, runUrl, serveStatic } from "../src/engine.js";
import { diffRuns, gateCode } from "../src/merge.js";
import { launchBrowser } from "../src/observe.js";
import { BUILTIN_PERSONAS } from "../src/personas.js";
import { privacyScanMedia } from "../src/replay.js";
import { leaderboard } from "../src/sweep.js";
import { preReport } from "../src/statechart.js";
import { readFileSync } from "node:fs";
import type { FindingKind, Persona, Run } from "../src/types.js";

const repo = join(import.meta.dirname, "..", "..");
const examples = join(repo, "examples");
const fixtures = join(repo, "ts", "fixtures");
const v1 = join(repo, "tests", "fixtures");
const started = Date.now();

let browser: Browser;

beforeAll(async () => {
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser.close();
});

async function open(root: string, page: string, opts: { personas?: readonly Persona[]; kind?: "auto" | "form" | "dashboard" } = {}): Promise<Run> {
  const server = await serveStatic(root);
  try {
    const url = new URL(page, server.url).href;
    return await runUrl(url, { browser, kind: opts.kind ?? "auto", ...(opts.personas ? { personas: opts.personas } : {}) });
  } finally {
    await server.close();
  }
}

function kindsOf(run: Run): Set<string> {
  return new Set(run.hotspots.flatMap((hotspot) => hotspot.kinds));
}

function controlsOf(run: Run): string[] {
  return run.hotspots.map((hotspot) => hotspot.control);
}

const persona = (id: string): Persona => {
  const found = BUILTIN_PERSONAS.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};

let badRun: Run | undefined;
let fixedRun: Run | undefined;

async function bad(): Promise<Run> {
  badRun ??= await open(examples, "signup.html");
  return badRun;
}

async function fixed(): Promise<Run> {
  fixedRun ??= await open(examples, "signup-fixed.html");
  return fixedRun;
}

it("AT1 bad bake sale is scored, at most 50, with at least 6 hotspots", async () => {
  const run = await bad();
  expect(run.verdict.kind).toBe("scored");
  if (run.verdict.kind !== "scored") return;
  expect(run.verdict.score).toBeLessThanOrEqual(50);
  expect(run.hotspots.length).toBeGreaterThanOrEqual(6);
});

it("AT2 top hotspot is Sign up, blocker, hit by at least 3 personas", async () => {
  const run = await bad();
  const top = run.hotspots[0];
  expect(top?.control).toBe("Sign up");
  expect(top?.severity).toBe("blocker");
  expect(top?.personas.length).toBeGreaterThanOrEqual(3);
  for (const kind of ["silent_failure", "unreachable_by_keyboard", "fake_button"] as const) {
    expect(top?.kinds).toContain(kind);
  }
});

it("AT3 hotspots do not share a control, and the menu icon is one hotspot", async () => {
  const run = await bad();
  expect(new Set(controlsOf(run)).size).toBe(run.hotspots.length);
  const menu = run.hotspots.filter((hotspot) => hotspot.control.includes("\u2630"));
  expect(menu).toHaveLength(1);
  expect(new Set(menu[0]?.kinds)).toEqual(new Set(["tiny_tap_target", "unnamed_control"]));
});

it("AT4 fixed page scores 100 and diff resolves every bad hotspot", async () => {
  const before = await bad();
  const after = await fixed();
  expect(after.verdict).toEqual({ kind: "scored", score: 100 });
  expect(after.sessions.every((session) => preReport(session) === "done")).toBe(true);
  const diff = diffRuns(before, after);
  expect(diff.resolved.map((hotspot) => hotspot.id).sort()).toEqual(before.hotspots.map((hotspot) => hotspot.id).sort());
  expect(diff.added).toEqual([]);
});

it("AT5 a 3500ms confirmation with 2000ms patience sticks the skimmer", async () => {
  const run = await bad();
  const skimmer = run.sessions.find((session) => session.persona === "skimmer");
  expect(preReport(skimmer!)).toBe("stuck");
  expect(kindsOf(run).has("slow_or_no_confirmation")).toBe(true);
});

it("AT6 an injected evaluate error is inconclusive and has no score", async () => {
  const server = await serveStatic(examples);
  try {
    const run = await runUrl(`${server.url}signup.html?frl_inject=evaluate-error`, { browser, kind: "form" });
    expect(run.verdict.kind).toBe("inconclusive");
    expect(JSON.stringify(run.verdict)).not.toContain("score");
    if (run.verdict.kind === "inconclusive") expect(run.verdict.crashed.length).toBe(5);
  } finally {
    await server.close();
  }
});

it("AT7 feedback counts live text, a new element, a URL change, and :invalid, not an unchanged alert", async () => {
  const live = await open(fixtures, "feedback-live.html", { personas: [persona("skimmer")], kind: "form" });
  const shown = await open(fixtures, "feedback-show.html", { personas: [persona("skimmer")], kind: "form" });
  const moved = await open(fixtures, "feedback-url.html", { personas: [persona("skimmer")], kind: "form" });
  const invalid = await open(fixtures, "feedback-invalid.html", { personas: [persona("skimmer")], kind: "form" });
  const same = await open(fixtures, "feedback-unchanged.html", { personas: [persona("skimmer")], kind: "form" });
  for (const run of [live, shown, moved, invalid]) expect(kindsOf(run).has("silent_failure")).toBe(false);
  expect(kindsOf(same).has("silent_failure")).toBe(true);
});

it("AT8 gate exits 0 on the fix, 1 on the bad page, and 2 when inconclusive", async () => {
  const good = await fixed();
  const broken = await bad();
  const server = await serveStatic(examples);
  try {
    const crashed = await runUrl(`${server.url}signup.html?frl_inject=evaluate-error`, {
      browser,
      kind: "form",
      personas: [persona("skimmer")],
    });
    expect(gateCode(good.verdict, 80)).toBe(0);
    expect(gateCode(broken.verdict, 80)).toBe(1);
    expect(gateCode(crashed.verdict, 80)).toBe(2);
  } finally {
    await server.close();
  }
});

it("AT9 refuses a remote URL before launch and aborts a cross-origin image", async () => {
  const t0 = Date.now();
  const code = await main(["run", "https://example.com", "--out", join(tmpdir(), "frl-remote")]);
  expect(code).toBe(64);
  expect(Date.now() - t0).toBeLessThan(2000);
  const run = await open(fixtures, "cross.html", { personas: [persona("phone")], kind: "form" });
  expect(run.blocked.some((url) => url.includes("example.com"))).toBe(true);
  expect(run.verdict.kind).toBe("scored");
});

it("AT10 privacy scan blocks an email fixture, and OCR catches one on a rendered frame", async () => {
  const server = await serveStatic(fixtures);
  const out = join(tmpdir(), `frl-email-${process.pid}`);
  rmSync(out, { recursive: true, force: true });
  try {
    const code = await main(["run", new URL("email.html", server.url).href, "--out", out, "--personas", "phone", "--kind", "form"]);
    expect(code).toBe(3);
    expect(existsSync(join(out, "run.json"))).toBe(false);
  } finally {
    await server.close();
  }
  const page = await browser.newPage({ viewport: { width: 800, height: 560 } });
  const cleanPath = join(tmpdir(), "frl-clean.png");
  const mailPath = join(tmpdir(), "frl-mail.png");
  await page.setContent("<h1>Pinecrest Bake Sale</h1><p>Sign up tripped up 4 of 5 personas. Score 36.</p>");
  await page.screenshot({ path: cleanPath });
  await page.setContent("<h1>a.b@example.com</h1>");
  await page.screenshot({ path: mailPath });
  await page.close();
  expect((await privacyScanMedia([cleanPath], [])).hits).toEqual([]);
  expect((await privacyScanMedia([mailPath], [])).hits).toContain("email");
});

it("AT11 a sweep leaderboard sorts by score and puts inconclusive last", async () => {
  const good = await fixed();
  const broken = await bad();
  const server = await serveStatic(examples);
  let crashed: Run;
  try {
    crashed = await runUrl(`${server.url}signup.html?frl_inject=evaluate-error`, {
      browser,
      kind: "form",
      personas: [persona("phone")],
    });
  } finally {
    await server.close();
  }
  const row = (name: string, run: Run) => ({
    name,
    score: run.verdict.kind === "scored" ? run.verdict.score : null,
    verdict: run.verdict.kind,
  });
  const board = leaderboard([row("bad", broken), row("crash", crashed), row("fixed", good)]);
  expect(board.map((item) => item.name)).toEqual(["fixed", "bad", "crash"]);
});

it("AT12 a JSON persona runs through the registered checks", async () => {
  const kid = personaFromJson(JSON.parse(readFileSync(join(repo, "personas", "tablet-kid.json"), "utf8")));
  const run = await open(fixtures, "tablet.html", { personas: [kid], kind: "form" });
  expect(run.sessions).toHaveLength(1);
  expect(run.sessions[0]?.persona).toBe("tablet-kid");
  expect(kindsOf(run).has("tiny_tap_target")).toBe(true);
  expect(kindsOf(run).has("unreachable_by_keyboard")).toBe(false);
});

it("AT14 two runs share hotspot ids and the score", async () => {
  const first = await bad();
  const second = await open(examples, "signup.html");
  expect(second.verdict).toEqual(first.verdict);
  expect(second.hotspots.map((hotspot) => hotspot.id)).toEqual(first.hotspots.map((hotspot) => hotspot.id));
});

it("v1 parity on examples/ stays within 2 points", async () => {
  const help = await open(examples, "help.html");
  const broken = await bad();
  const good = await fixed();
  const score = (run: Run) => (run.verdict.kind === "scored" ? run.verdict.score : -1);
  expect(Math.abs(score(broken) - 36)).toBeLessThanOrEqual(2);
  expect(Math.abs(score(good) - 100)).toBeLessThanOrEqual(2);
  expect(Math.abs(score(help) - 98)).toBeLessThanOrEqual(2);
  console.log(`parity bad=${score(broken)} fixed=${score(good)} help=${score(help)}`);
});

it("closed details and collapsed accordions are not nameless controls", async () => {
  const run = await open(fixtures, "closed-section.html", {
    personas: [persona("keyboard"), persona("phone"), persona("screenreader")],
    kind: "form",
  });
  const names = controlsOf(run);
  expect(names).not.toContain("hidden-btn");
  expect(names).not.toContain("buried");
  expect(names).not.toContain("Inside accordion");
  expect(names).not.toContain("DIV");
  expect(names).toContain("shown");
  expect(kindsOf(run).has("unnamed_control")).toBe(false);
});

it("keyboard tabbing continues until focus wraps, past control count + 5", async () => {
  const run = await open(fixtures, "tab-wrap.html", { personas: [persona("keyboard")], kind: "form" });
  const missed = run.hotspots
    .filter((hotspot) => hotspot.kinds.includes("unreachable_by_keyboard" as FindingKind))
    .map((hotspot) => hotspot.control);
  expect(missed).toContain("Go");
  expect(missed).not.toContain("Send");
  expect(missed).not.toContain("Save");
  const caption = run.sessions[0]?.frames.map((frame) => frame.caption).join(" ") ?? "";
  const tabs = Number(/tabs through the page \((\d+)\)/.exec(caption)?.[1] ?? "0");
  expect(tabs).toBeGreaterThan(3 + 5);
  expect(tabs).toBeLessThanOrEqual(500);
});

it("canvas, toast, and focus count as feedback; role=button text is a name", async () => {
  const canvas = await open(join(v1, "o1"), "canvas.html", { personas: [persona("skimmer")], kind: "form" });
  const toast = await open(join(v1, "o1"), "toast.html", { personas: [persona("skimmer")], kind: "form" });
  const focus = await open(join(v1, "o1"), "focus.html", { personas: [persona("skimmer")], kind: "form" });
  const role = await open(join(v1, "o1"), "rolebtn.html", { personas: [persona("screenreader")], kind: "dashboard" });
  expect(kindsOf(canvas).has("silent_failure")).toBe(false);
  expect(kindsOf(toast).has("silent_failure")).toBe(false);
  expect(kindsOf(focus).has("silent_failure")).toBe(false);
  expect(kindsOf(role).has("unnamed_control")).toBe(false);
});

it("dashboard mode downgrades a missing call to action", async () => {
  const form = await open(join(v1, "o2"), "dash.html", { personas: [persona("skimmer")], kind: "form" });
  const dash = await open(join(v1, "o2"), "dash.html", { personas: [persona("skimmer")], kind: "dashboard" });
  const auto = await open(join(v1, "o2"), "dash.html", { personas: [persona("skimmer")], kind: "auto" });
  const sev = (run: Run) => run.hotspots.find((hotspot) => hotspot.kinds.includes("no_clear_cta"))?.severity;
  expect(sev(form)).toBe("major");
  expect(sev(dash)).toBe("minor");
  expect(auto.kind).toBe("dashboard");
  if (form.verdict.kind === "scored" && dash.verdict.kind === "scored") {
    expect(dash.verdict.score).toBeGreaterThan(form.verdict.score);
  }
});

it("a covered action is a finding, external links are skipped, and API failures are classified", async () => {
  const covered = await open(join(v1, "o1"), "covered.html", { personas: [persona("skimmer")], kind: "form" });
  expect(covered.verdict.kind).toBe("scored");
  expect(kindsOf(covered).has("unclickable_cta")).toBe(true);
  const links = await open(join(v1, "o1"), "extlinks.html", {
    personas: [persona("skimmer"), persona("curious")],
    kind: "form",
  });
  const dead = links.hotspots.filter((hotspot) => hotspot.kinds.includes("dead_link")).map((hotspot) => hotspot.control);
  expect(dead).toEqual(["Local page"]);
  expect(kindsOf(links).has("silent_failure")).toBe(false);
  const missing = await open(join(v1, "o1"), "needsapi.html", { personas: [persona("phone")], kind: "form" });
  expect(missing.verdict.kind).toBe("needs_backend");
  const partial = await open(join(v1, "o1"), "partialapi.html", { personas: [persona("phone")], kind: "form" });
  expect(partial.verdict.kind).toBe("scored");
  expect(kindsOf(partial).has("broken_api")).toBe(true);
  const gone = await open(join(v1, "o1"), "missing.html", { personas: [persona("phone")], kind: "form" });
  expect(gone.verdict.kind).toBe("unreachable");
});

it("AT15 the fixture runs finish in under 60s", () => {
  expect(Date.now() - started).toBeLessThan(60_000);
});
