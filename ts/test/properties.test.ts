import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import fc from "fast-check";
import { IllegalTransition, SESSION_TABLE } from "../src/statechart.generated.ts";
import { hotspotId, merge, SEV } from "../src/merge.ts";
import { score } from "../src/score.ts";
import { piiHits } from "../src/privacy.ts";
import { Session } from "../src/session.ts";
import { replaySession } from "../src/trace.ts";
import { REPO_ROOT } from "../src/root.ts";
import { codeGroups, groupReport, prepareStatic, startHint, buildHint } from "../src/sweep.ts";
import { BUILTIN } from "../src/personas.ts";
import type { ControlKey, Finding, FindingKind, PersonaId, Severity } from "../src/types.ts";

const KINDS = [
  "no_clear_cta", "silent_failure", "slow_or_no_confirmation", "unreachable_by_keyboard",
  "invisible_focus", "tiny_tap_target", "small_tap_target", "horizontal_scroll",
  "unnamed_control", "unlabeled_field", "fake_button", "dead_link",
] as const satisfies readonly FindingKind[];

test("generated statechart matches the TLA+ tables", () => {
  execFileSync("node", [path.join(REPO_ROOT, "tools", "gen-statechart.mjs"), "--check"], { cwd: REPO_ROOT });
  assert.ok(SESSION_TABLE.some((t) => t.from === "crashed" && t.why === "report" && t.to === "reported"));
  assert.equal(SESSION_TABLE.length, 12);
});

test("AT13 TLC output shows a clean model and three killed mutants", () => {
  const read = (name: string) => fs.readFileSync(path.join(REPO_ROOT, "spec", "tlc", name), "utf8");
  assert.match(read("none.out"), /No error has been found/);
  assert.match(read("none.out"), /I1|temporal properties/i);
  assert.match(read("drop_crashed_report.out"), /Temporal properties were violated/);
  assert.match(read("drop_crashed_report.out"), /crashed/);
  assert.match(read("score_while_crashed.out"), /Invariant I3 is violated/);
  assert.match(read("merge_drops.out"), /Invariant I6 is violated/);
});

test("illegal session step throws", () => {
  const s = new Session(BUILTIN[0]);
  assert.throws(() => s.go("reported", "report"), IllegalTransition);
  assert.throws(() => replaySession([
    { from: "queued", to: "reported", why: "report", atMs: 0 },
  ]), IllegalTransition);
});

test("a legal log replays to reported", () => {
  const log = [
    { from: "queued", to: "launching", why: "start", atMs: 1 },
    { from: "launching", to: "exploring", why: "loaded", atMs: 2 },
    { from: "exploring", to: "exploring", why: "step", atMs: 3 },
    { from: "exploring", to: "stuck", why: "gave_up", atMs: 4 },
    { from: "stuck", to: "reported", why: "report", atMs: 5 },
  ];
  assert.equal(replaySession(log), "reported");
});

test("score stays inside the caps", () => {
  assert.equal(score([]), 100);
  assert.equal(score(Array.from({ length: 9 }, () => ({ severity: "blocker" as const }))), 40);
  assert.equal(score(Array.from({ length: 4 }, () => ({ severity: "blocker" as const }))), 40);
  assert.equal(score(Array.from({ length: 20 }, () => ({ severity: "minor" as const }))), 90);
  assert.equal(score(Array.from({ length: 6 }, () => ({ severity: "major" as const }))), 70);
  fc.assert(fc.property(
    fc.array(fc.constantFrom<Severity>("blocker", "major", "minor"), { maxLength: 40 }),
    (sevs) => {
      const s = score(sevs.map((severity) => ({ severity })));
      return s >= 0 && s <= 100;
    },
  ));
  fc.assert(fc.property(
    fc.array(fc.constantFrom<Severity>("blocker", "major", "minor"), { minLength: 1, maxLength: 20 }),
    (sevs) => score(sevs.map((severity) => ({ severity }))) <= score(sevs.slice(0, -1).map((severity) => ({ severity }))),
  ));
});

test("merge keeps every finding, one hotspot per control, stable ids", () => {
  const finding = fc.record({
    persona: fc.constantFrom("skimmer", "phone", "keyboard", "screenreader", "curious"),
    kind: fc.constantFrom(...KINDS),
    severity: fc.constantFrom<Severity>("blocker", "major", "minor"),
    control: fc.string({ minLength: 1, maxLength: 24 }),
    detail: fc.string({ maxLength: 40 }),
    step: fc.integer({ min: 0, max: 12 }),
  });
  fc.assert(fc.property(fc.array(finding, { maxLength: 25 }), (rows) => {
    const findings: Finding[] = rows.map((r) => ({
      persona: r.persona as PersonaId,
      kind: r.kind,
      severity: r.severity,
      control: r.control as ControlKey,
      detail: r.detail,
      evidence: { shot: "" },
      step: r.step,
    }));
    const hot = merge(findings);
    if (hot.reduce((n, h) => n + h.details.length, 0) !== findings.length) return false;
    if (hot.length !== new Set(findings.map((f) => f.control)).size) return false;
    for (const h of hot) {
      const group = findings.filter((f) => f.control === h.control);
      const max = Math.max(...group.map((f) => SEV[f.severity]));
      if (SEV[h.severity] !== max) return false;
      if (h.id !== hotspotId(String(h.control))) return false;
      if (new Set(hot.map((x) => x.control)).size !== hot.length) return false;
    }
    const shuffled = merge([...findings].reverse());
    const ids = (hs: { id: string }[]) => hs.map((h) => h.id).sort().join(",");
    return ids(hot) === ids(shuffled);
  }), { numRuns: 80 });
});

test("hotspot id is F + sha1(control)[0:6] and ignores order", () => {
  assert.equal(hotspotId("Sign up"), hotspotId("Sign up"));
  assert.notEqual(hotspotId("Sign up"), hotspotId("Help"));
  assert.match(hotspotId("Sign up"), /^F[0-9a-f]{6}$/);
  const a: Finding = { persona: "skimmer" as PersonaId, kind: "silent_failure", severity: "blocker", control: "Sign up" as ControlKey, detail: "a", evidence: { shot: "" }, step: 1 };
  const b: Finding = { ...a, persona: "keyboard" as PersonaId, kind: "fake_button", severity: "major", detail: "b" };
  assert.equal(merge([a, b])[0].id, merge([b, a])[0].id);
});

test("privacy regex flags an email and ignores the bake-sale copy", () => {
  assert.ok(piiHits("mail me at a.b@example.com").length);
  assert.equal(piiHits("Sign up button 12x12px").length, 0);
});

test("shared-code groups and start hints", () => {
  const root = path.join(REPO_ROOT, "tests", "fixtures", "o3");
  const groups = codeGroups(root, ["a", "b", "c", "d"]);
  assert.equal(Object.keys(groups).length, 1);
  assert.deepEqual([...Object.values(groups)[0]].sort(), ["a", "b"]);
  const res = groupReport({ a: { hotspots: 1 }, b: { hotspots: 1 } } as Record<string, { hotspots: number; group?: string; dup_of?: string }>, groups);
  assert.equal(res.b.dup_of, "a");
  assert.equal(res.a.dup_of, undefined);
  const py = path.join(REPO_ROOT, "tests", "fixtures", "o4", "pyapp");
  assert.match(startHint(py) || "", /--demo/);
  assert.equal(buildHint(py), "python3 build.py");
});

test("template apps are inlined or built before they would be served raw", () => {
  const root = path.join(REPO_ROOT, "tests", "fixtures", "tpl");
  fs.rmSync(path.join(root, "tplapp", "dist"), { recursive: true, force: true });
  const built = prepareStatic(root, "tplapp");
  assert.equal(built.how, "build.py");
  const html = fs.readFileSync(path.join(built.dir, built.page), "utf8");
  assert.ok(!html.includes("/*__"));
  assert.match(html, /min-height:48px/);
  const inline = prepareStatic(root, "nobuild");
  assert.equal(inline.how, "inline");
  assert.ok(!fs.readFileSync(path.join(inline.dir, inline.page), "utf8").includes("/*__"));
  fs.rmSync(path.join(root, "tplapp", "dist"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "nobuild", "_frl_built"), { recursive: true, force: true });
});
