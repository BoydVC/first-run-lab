import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { diffRuns } from "../src/diff.ts";
import { dashboardHtml } from "../src/dashboard.ts";
import { armFeedback, assertAllowed, gateCode, RefuseHost, run, watchFeedback, TAB_CAP } from "../src/engine.ts";
import { BUILTIN, loadPersonas } from "../src/personas.ts";
import { PrivacyError } from "../src/privacy.ts";
import { ocrImage, piiHits } from "../src/privacy.ts";
import { replaySession } from "../src/trace.ts";
import { REPO_ROOT } from "../src/root.ts";
import { serveDir } from "../src/static.ts";
import { isolatedLanding, launch, sortBoard, sweepUrls } from "../src/sweep.ts";
import type { Persona, Run } from "../src/types.ts";

const exec = promisify(execFile);
const results: { id: string; pass: boolean; detail: string }[] = [];
let browser: Browser;
const t0 = Date.now();

function one(id: string): Persona {
  const p = BUILTIN.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
}

async function withPage(file: string, personas: Persona[], extra: Partial<Parameters<typeof run>[0]> = {}): Promise<Run> {
  const abs = path.isAbsolute(file) ? file : path.join(REPO_ROOT, file);
  const srv = await serveDir(path.dirname(abs));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "frl-"));
  try {
    const rep = await run({
      url: new URL(path.basename(abs), srv.url).href,
      out,
      personas,
      shots: false,
      browser,
      kind: "form",
      ...extra,
    });
    for (const s of rep.sessions) if (s.log.length) replaySession(s.log);
    return rep;
  } finally {
    await srv.close();
  }
}

async function check(id: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ id, pass: true, detail: "" });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ id, pass: false, detail });
    throw e;
  }
}

describe("acceptance", { concurrency: 1 }, () => {
  before(async () => {
    browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  });
  after(async () => {
    await browser?.close();
    const ms = Date.now() - t0;
    results.push({ id: "AT15", pass: ms < 60000, detail: `${ms}ms` });
    fs.mkdirSync(path.join(REPO_ROOT, "spec"), { recursive: true });
    fs.writeFileSync(path.join(REPO_ROOT, "spec", "acceptance-results.json"), JSON.stringify({ ms, results }, null, 2));
  });

  test("AT1 AT2 AT3 AT5 bad signup", async () => {
    await check("AT1", async () => {
      const rep = await withPage("examples/signup.html", BUILTIN);
      assert.equal(rep.verdict.kind, "scored");
      if (rep.verdict.kind !== "scored") return;
      assert.ok(rep.verdict.score <= 50, `score ${rep.verdict.score}`);
      assert.ok(rep.hotspots.length >= 6, `hotspots ${rep.hotspots.length}`);
      (globalThis as { __bad?: Run }).__bad = rep;
    });
    const rep = (globalThis as { __bad?: Run }).__bad!;
    await check("AT2", async () => {
      const top = rep.hotspots[0];
      assert.equal(top.control, "Sign up");
      assert.equal(top.severity, "blocker");
      assert.ok(top.personas.length >= 3, top.personas.join(","));
      for (const k of ["silent_failure", "unreachable_by_keyboard", "fake_button"] as const) {
        assert.ok(top.kinds.includes(k), top.kinds.join(","));
      }
    });
    await check("AT3", async () => {
      const controls = rep.hotspots.map((h) => h.control);
      assert.equal(new Set(controls).size, controls.length);
      const menu = rep.hotspots.find((h) => h.kinds.includes("tiny_tap_target") && h.kinds.includes("unnamed_control"));
      assert.ok(menu, rep.hotspots.map((h) => `${h.control}:${h.kinds}`).join(" | "));
      assert.equal(rep.hotspots.filter((h) => h.control === menu!.control).length, 1);
    });
    await check("AT5", async () => {
      const sk = rep.sessions.find((s) => s.persona === "skimmer")!;
      assert.equal(sk.log.at(-1)?.from, "stuck");
      assert.ok(sk.findings.some((f) => f.kind === "slow_or_no_confirmation"));
    });
  });

  test("AT4 fixed page scores 100 and diff resolves every bad hotspot", async () => {
    await check("AT4", async () => {
      const bad = (globalThis as { __bad?: Run }).__bad ?? await withPage("examples/signup.html", BUILTIN);
      const fixed = await withPage("examples/signup-fixed.html", BUILTIN);
      assert.equal(fixed.verdict.kind, "scored");
      if (fixed.verdict.kind === "scored") assert.equal(fixed.verdict.score, 100);
      assert.ok(fixed.sessions.every((s) => s.log.at(-1)?.from === "done"));
      const diff = diffRuns(bad, fixed);
      assert.equal(diff.resolved.length, bad.hotspots.length);
      assert.equal(diff.added.length, 0);
    });
  });

  test("AT6 a throwing page is inconclusive and has no score", async () => {
    await check("AT6", async () => {
      const rep = await withPage("ts/fixtures/throw.html", BUILTIN);
      assert.equal(rep.verdict.kind, "inconclusive");
      assert.equal("score" in rep.verdict, false);
      if (rep.verdict.kind === "inconclusive") assert.ok(rep.verdict.crashed.length >= 1);
    });
  });

  test("AT7 feedback counts live text, new nodes, URL, :invalid, canvas, and focus, not identical text", async () => {
    await check("AT7", async () => {
      const page = await browser.newPage();
      const probe = async (html: string, click: string) => {
        await page.setContent(html, { waitUntil: "load" });
        await armFeedback(page);
        await page.click(click);
        return watchFeedback(page, 800);
      };
      assert.ok(await probe(`<p id=t role=alert></p><button id=b onclick="t.textContent='Saved'">Save</button>`, "#b") != null);
      assert.ok(await probe(`<p id=t style="display:none">Hi</p><button id=b onclick="t.style.display='block'">Save</button>`, "#b") != null);
      assert.ok(await probe(`<button id=b onclick="location.href=location.href+'#next'">Go</button>`, "#b") != null);
      assert.ok(await probe(`<form><input id=q required><button id=b>Send</button></form>`, "#b") != null);
      assert.ok(await probe(`<canvas id=c width=40 height=40></canvas><button id=b onclick="c.getContext('2d').fillRect(0,0,10,10)">Play</button>`, "#b") != null);
      assert.ok(await probe(`<label>Q <input id=q></label><button id=b onclick="q.focus()">Start</button>`, "#b") != null);
      assert.equal(await probe(`<p id=t role=alert>Same</p><button id=b onclick="t.textContent='Same'">Save</button>`, "#b"), null);
      await page.close();
    });
  });

  test("AT8 gate exits 0, 1, and 2", async () => {
    await check("AT8", async () => {
      const fixed = await withPage("examples/signup-fixed.html", BUILTIN);
      const bad = (globalThis as { __bad?: Run }).__bad!;
      const crashed = await withPage("ts/fixtures/throw.html", [one("skimmer")]);
      assert.equal(gateCode(fixed, 80), 0);
      assert.equal(gateCode(bad, 80), 1);
      assert.equal(gateCode(crashed, 80), 2);
      const cli = path.join(REPO_ROOT, "ts", "src", "cli.ts");
      const tsx = path.join(REPO_ROOT, "ts", "node_modules", "tsx", "dist", "esm", "index.mjs");
      const runCli = (args: string[]) => exec("node", ["--import", tsx, cli, ...args], { cwd: REPO_ROOT });
      const good = await runCli(["gate", "examples/signup-fixed.html", "--min", "80", "--no-shots", "--kind", "form"]).then((r) => r, (e) => e);
      assert.equal(good.code ?? 0, 0);
      const low = await runCli(["gate", "examples/signup.html", "--min", "80", "--no-shots", "--kind", "form"]).then((r) => r, (e) => e);
      assert.equal(low.code, 1);
    });
  });

  test("AT9 remote hosts are refused before launch and cross-origin requests are aborted", async () => {
    await check("AT9", async () => {
      const t = Date.now();
      assert.throws(() => assertAllowed("https://example.com", ["127.0.0.1", "localhost"]), RefuseHost);
      assert.ok(Date.now() - t < 500);
      const cli = path.join(REPO_ROOT, "ts", "src", "cli.ts");
      const tsx = path.join(REPO_ROOT, "ts", "node_modules", "tsx", "dist", "esm", "index.mjs");
      const refused = await exec("node", ["--import", tsx, cli, "run", "https://example.com", "--no-shots"], { cwd: REPO_ROOT }).then((r) => r, (e) => e);
      assert.equal(refused.code, 64);
      const rep = await withPage("ts/fixtures/cross.html", [one("curious")]);
      assert.ok(rep.blocked.some((u) => u.includes("example.com")), rep.blocked.join(" "));
    });
  });

  test("AT10 privacy scan blocks an email fixture", async () => {
    await check("AT10", async () => {
      const abs = path.join(REPO_ROOT, "ts", "fixtures", "email.html");
      const srv = await serveDir(path.dirname(abs));
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "frl-mail-"));
      fs.rmSync(out, { recursive: true });
      try {
        await assert.rejects(
          () => run({ url: new URL("email.html", srv.url).href, out, personas: [one("curious")], shots: false, browser, kind: "form" }),
          PrivacyError,
        );
        assert.equal(fs.existsSync(path.join(out, "run.json")), false);
      } finally {
        await srv.close();
      }
    });
  });

  test("AT11 sweep sorts scored apps ahead of inconclusive", async () => {
    await check("AT11", async () => {
      const good = await serveDir(path.join(REPO_ROOT, "examples"));
      const bad = await serveDir(path.join(REPO_ROOT, "ts", "fixtures"));
      try {
        const board = await sweepUrls([
          { name: "fixed", url: new URL("signup-fixed.html", good.url).href },
          { name: "throws", url: new URL("throw.html", bad.url).href },
        ], BUILTIN, browser, "form");
        assert.equal(board[0].name, "fixed");
        assert.equal(board[0].score, 100);
        assert.equal(board[1].score, null);
        assert.match(board[1].verdict, /inconclusive/);
        assert.deepEqual(sortBoard(board).map((e) => e.name), ["fixed", "throws"]);
      } finally {
        await good.close();
        await bad.close();
      }
    });
  });

  test("AT12 a JSON persona runs from its checks alone", async () => {
    await check("AT12", async () => {
      const personas = loadPersonas(path.join(REPO_ROOT, "personas"), ["tablet-kid"]);
      assert.equal(personas[0].viewport.w, 1024);
      assert.equal(personas[0].patienceMs, 4000);
      assert.equal(personas[0].touch, true);
      const rep = await withPage("ts/fixtures/tiny.html", personas);
      assert.equal(rep.sessions[0].log.at(-1)?.to, "reported");
      assert.ok(rep.sessions[0].log.at(-1)?.from !== "crashed");
      assert.ok(rep.hotspots.some((h) => h.kinds.includes("tiny_tap_target") && h.personas.includes("tablet-kid" as never)));
    });
  });

  test("AT14 two runs agree on score and hotspot ids", async () => {
    await check("AT14", async () => {
      const a = await withPage("examples/signup.html", BUILTIN);
      const b = await withPage("examples/signup.html", BUILTIN);
      assert.equal(a.verdict.kind, "scored");
      assert.deepEqual(a.verdict, b.verdict);
      assert.deepEqual(a.hotspots.map((h) => h.id), b.hotspots.map((h) => h.id));
    });
  });

  test("closed sections are not nameless controls", async () => {
    await check("closed-section", async () => {
      const rep = await withPage("ts/fixtures/closed-section.html", [one("screenreader")]);
      const unnamed = rep.sessions[0].findings.filter((f) => f.kind === "unnamed_control").map((f) => f.control);
      assert.deepEqual(unnamed, ["seen-icon"]);
      assert.ok(!unnamed.includes("hidden-details" as never));
      assert.ok(!unnamed.includes("hidden-acc" as never));
    });
  });

  test("keyboard tabs until focus wraps, past control-count + 5", async () => {
    await check("tab-wrap", async () => {
      assert.ok(TAB_CAP >= 500);
      const rep = await withPage("ts/fixtures/long-tab.html", [one("keyboard")]);
      const missed = rep.sessions[0].findings.filter((f) => f.kind === "unreachable_by_keyboard").map((f) => String(f.control));
      assert.deepEqual(missed, ["Ghost"]);
      assert.ok(!rep.sessions[0].findings.some((f) => f.kind === "invisible_focus"));
    });
  });

  test("WCAG tap targets: 24px major, 44px minor on buttons only", async () => {
    await check("tap-targets", async () => {
      const rep = await withPage("ts/fixtures/tiny.html", [one("phone")]);
      const kind = (control: string) => rep.hotspots.find((h) => h.control === control)?.kinds ?? [];
      assert.ok(kind("Go").includes("tiny_tap_target"));
      assert.ok(kind("Add").includes("small_tap_target"));
      assert.ok(!kind("Add").includes("tiny_tap_target"));
      assert.ok(kind("Pin").includes("tiny_tap_target"));
      assert.deepEqual(kind("Qty"), []);
      assert.deepEqual(kind("Help"), []);
    });
  });

  test("canvas change, dashboard mode, and offline start hints", async () => {
    await check("canvas-dashboard-hints", async () => {
      const canvas = await withPage("tests/fixtures/o1/canvas.html", [one("skimmer")]);
      assert.ok(!canvas.hotspots.some((h) => h.kinds.includes("silent_failure")));
      const toast = await withPage("tests/fixtures/o1/toast.html", [one("skimmer")]);
      assert.ok(!toast.hotspots.some((h) => h.kinds.includes("silent_failure")));
      const focus = await withPage("tests/fixtures/o1/focus.html", [one("skimmer")]);
      assert.ok(!focus.hotspots.some((h) => h.kinds.includes("silent_failure")));
      const form = await withPage("tests/fixtures/o2/dash.html", [one("skimmer")], { kind: "form" });
      const dash = await withPage("tests/fixtures/o2/dash.html", [one("skimmer")], { kind: "dashboard" });
      const sev = (r: Run) => r.hotspots.find((h) => h.kinds.includes("no_clear_cta"))?.severity;
      assert.equal(sev(form), "major");
      assert.equal(sev(dash), "minor");
      const auto = await withPage("tests/fixtures/o2/dash.html", [one("skimmer")], { kind: "auto" });
      assert.equal(auto.kind, "dashboard");
      const py = path.join(REPO_ROOT, "tests", "fixtures", "o4", "pyapp");
      const started = await launch(py, 8891);
      try {
        const body = await (await fetch(started.url)).text();
        assert.match(body, /Sample Team/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(py, "built.json"), "utf8")).net, false);
      } finally {
        started.stop();
      }
      const net = path.join(REPO_ROOT, "tests", "fixtures", "o4", "netapp");
      const text = await isolatedLanding(net, { netapp: "python3 server.py", "netapp:port": "4311" });
      assert.match(text, /offline/);
      assert.doesNotMatch(text, /ONLINE/);
    });
  });

  test("dashboard renders the statechart, hotspots, and a before/after slider", async () => {
    await check("dashboard", async () => {
      const fixed = await withPage("examples/signup-fixed.html", [one("skimmer")]);
      const html = dashboardHtml([{ name: "bad", run: (globalThis as { __bad?: Run }).__bad! }, { name: "fixed", run: fixed }]);
      assert.match(html, /queued/);
      assert.match(html, /reported/);
      assert.match(html, /statechart/);
      assert.match(html, /hotspots/);
      assert.match(html, /type=range/);
    });
  });

  test("AT15 fixture suite stays under 60s", () => {
    const ms = Date.now() - t0;
    assert.ok(ms < 60000, `suite took ${ms}ms`);
  });
});

test("committed demo gif has no OCR hits", async () => {
  const gif = path.join(REPO_ROOT, "screenshots", "demo-ts.gif");
  if (!fs.existsSync(gif)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frl-ocr-"));
  await exec("ffmpeg", ["-y", "-i", gif, path.join(tmp, "f%03d.png")]);
  let text = "";
  for (const name of fs.readdirSync(tmp)) text += await ocrImage(path.join(tmp, name));
  assert.deepEqual(piiHits(text), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
