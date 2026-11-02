import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { headline } from "../src/copy.js";
import { PrivacyError, privacyHits } from "../src/privacy.js";
import { renderDiff, renderReport, renderStatechart, sortBoard } from "../src/report.js";
import { hotspotId, scoreHotspots } from "../src/score.js";
import { can, createSession, go, TRANSITIONS } from "../src/state.js";
import { TAB_CAP } from "../src/engine.js";
import { buildHint, codeGroups, prepareStatic, startHint } from "../src/sweep.js";
import type { Run } from "../src/types.js";

const root = join(import.meta.dirname, "..", "..");

describe("score, state, copy", () => {
  it("caps the score the way the spec does", () => {
    assert.equal(scoreHotspots([]), 100);
    assert.equal(scoreHotspots(Array.from({ length: 9 }, () => ({ severity: "blocker" as const }))), 40);
    assert.equal(scoreHotspots([{ severity: "blocker" }, { severity: "blocker" }, { severity: "major" }, { severity: "major" }, { severity: "major" }, { severity: "major" }]), 36);
  });

  it("hotspot ids are sha1 prefixes", () => {
    assert.equal(hotspotId("Sign up"), "F0b8149");
    assert.equal(hotspotId("☰"), "Fda86fe");
  });

  it("rejects an illegal transition and reaches reported", () => {
    const s = createSession("x");
    assert.throws(() => go(s, "reported", "nope"), /illegal/);
    go(s, "launching", "start");
    go(s, "exploring", "loaded");
    go(s, "done", "checks_complete");
    go(s, "reported", "report");
    assert.equal(s.state, "reported");
    assert.equal(can("reported", "exploring"), false);
    for (const state of Object.keys(TRANSITIONS)) {
      const seen = new Set<string>();
      const stack = [state];
      while (stack.length) {
        const x = stack.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const e of TRANSITIONS[x as keyof typeof TRANSITIONS]) if (!seen.has(e.to)) stack.push(e.to);
      }
      assert.ok(seen.has("reported"), state);
    }
  });

  it("privacy scan catches an email and ignores the bake-sale copy", () => {
    assert.ok(privacyHits("mail me at a.b@example.com").includes("email"));
    assert.deepEqual(privacyHits("Sign up button 12x12px"), []);
  });

  it("the dial is grey and says Inconclusive when a persona crashed", () => {
    const run: Run = {
      schema: 1, id: "x", url: "http://127.0.0.1:1/", startedAt: "t", kind: "form", blocked: [],
      sessions: [], hotspots: [], verdict: { kind: "inconclusive", crashed: ["skimmer"] },
    };
    const html = renderReport(run);
    assert.match(html, /class="dial inconclusive"/);
    assert.match(html, />Inconclusive</);
    assert.equal(headline(run).startsWith("Inconclusive"), true);
    assert.doesNotMatch(html, /aria-label="Score/);
  });

  it("a diff page has a keyboard-operable before/after slider", () => {
    const scored = (score: number): Run => ({
      schema: 1, id: String(score), url: "http://127.0.0.1/", startedAt: "t", kind: "form", blocked: [],
      sessions: [], hotspots: [], verdict: { kind: "scored", score },
    });
    const html = renderDiff(scored(36), scored(100));
    assert.match(html, /type="range"/);
    assert.match(html, /Before/);
    assert.match(html, /After/);
    assert.match(html, /aria-valuemin="0"/);
  });

  it("the statechart lists every edge in the transition table", () => {
    const html = renderStatechart();
    for (const [from, edges] of Object.entries(TRANSITIONS)) {
      for (const e of edges) assert.match(html, new RegExp(`${from}[\\s\\S]{0,80}${e.why}`));
    }
    const tla = readFileSync(join(import.meta.dirname, "..", "tla", "Session.tla"), "utf8");
    const pairs = [...tla.matchAll(/<<"([^"]+)", "([^"]+)">>/g)].map((m) => `${m[1]}->${m[2]}`).sort();
    const fromTs: string[] = [];
    for (const [from, edges] of Object.entries(TRANSITIONS)) for (const e of edges) fromTs.push(`${from}->${e.to}`);
    assert.deepEqual(pairs.filter((p, i, a) => a.indexOf(p) === i).sort(), fromTs.sort());
  });

  it("keyboard tab cap is 500, not control-count plus five", () => {
    assert.equal(TAB_CAP, 500);
    const src = readFileSync(join(import.meta.dirname, "..", "src", "engine.ts"), "utf8");
    assert.equal(src.includes("length + 5"), false);
    assert.match(src, /details/);
    assert.match(src, /aria-expanded/);
  });

  it("leaderboard sorts unscored runs last", () => {
    const rows = sortBoard([
      { name: "c", score: null, verdict: "inconclusive", kinds: [] },
      { name: "b", score: 60, verdict: "scored", kinds: [] },
      { name: "a", score: 98, verdict: "scored", kinds: [] },
    ]);
    assert.deepEqual(rows.map((r) => r.name), ["a", "b", "c"]);
  });
});

describe("sweep helpers", () => {
  it("groups shared code and leaves empty apps alone", () => {
    const g = codeGroups(join(root, "tests", "fixtures", "o3"), ["a", "b", "c", "d"]);
    assert.equal(Object.keys(g).length, 1);
    assert.deepEqual([...Object.values(g)[0]].sort(), ["a", "b"]);
  });

  it("reads offline start hints", () => {
    const dir = join(root, "tests", "fixtures", "o4", "pyapp");
    assert.match(startHint(dir) || "", /--demo/);
    assert.equal(buildHint(dir), "python3 build.py");
  });

  it("builds a template offline before it would be scored", () => {
    const tmp = mkdtempSync(join(tmpdir(), "frl-tpl-"));
    const src = join(root, "tests", "fixtures", "tpl");
    spawnSync("cp", ["-a", src, join(tmp, "tpl")]);
    const root2 = join(tmp, "tpl");
    rmSync(join(root2, "tplapp", "dist"), { recursive: true, force: true });
    const built = prepareStatic(root2, "tplapp");
    assert.equal(built.how, "build.py");
    const html = readFileSync(join(built.dir, built.page), "utf8");
    assert.equal(html.includes("/*__"), false);
    assert.match(html, /min-height:48px/);
    const inline = prepareStatic(root2, "nobuild");
    assert.equal(inline.how, "inline");
    assert.equal(readFileSync(join(inline.dir, inline.page), "utf8").includes("/*__"), false);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("TLA+", () => {
  it("TLC accepts the statechart and the crashed-edge mutant fails I1", () => {
    const r = spawnSync("bash", [join(import.meta.dirname, "..", "scripts", "check-tla.sh")], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

void PrivacyError;
