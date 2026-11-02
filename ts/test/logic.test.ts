import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personaFromJson } from "../src/engine.js";
import { diffRuns, gateCode, hotspotDetailCount, mergeFindings, scoreOf } from "../src/merge.js";
import { phone, screenreader } from "../src/personas.js";
import { privacyHits } from "../src/privacy.js";
import { apply, createSession, legalTargets } from "../src/statechart.js";
import { codeGroups, startHint } from "../src/sweep.js";
import { renderSessionTla } from "../src/tla.js";
import {
  controlKey,
  personaId,
  scored,
  inconclusive,
  SESSION_STATES,
  type Hotspot,
  type Persona,
  type Run,
  type Session,
} from "../src/types.js";
import type { PageSnapshot } from "../src/snapshot.js";

const repo = join(import.meta.dirname, "..", "..");

function session(id: string, findings: Session["findings"]): Session {
  return { persona: personaId(id), state: "reported", log: [], findings, frames: [], steps: 1 };
}

function finding(persona: string, kind: Session["findings"][number]["kind"], control: string): Session["findings"][number] {
  return {
    persona: personaId(persona),
    kind,
    severity: kind === "silent_failure" ? "blocker" : "major",
    control: control === "page" ? "page" : controlKey(control),
    detail: kind,
    evidence: { shot: "shots/x.png" },
    step: 1,
  };
}

describe("statechart", () => {
  it("rejects an illegal edge at runtime", () => {
    const queued = createSession(personaId("skimmer"));
    expect(() => apply(queued, "reported", "no", 0)).toThrow(/illegal queued->reported/);
  });

  it("rejects stuck before a step", () => {
    let exploring = apply(createSession(personaId("skimmer")), "launching", "start", 0);
    exploring = apply(exploring, "exploring", "loaded", 1);
    expect(() => apply(exploring, "stuck", "gave_up", 2)).toThrow(/I4/);
    const stepped = apply(exploring, "exploring", "step", 2);
    expect(apply(stepped, "stuck", "gave_up", 3).state).toBe("stuck");
  });

  it("reported is the only sink and every state can reach it", () => {
    const sinks = SESSION_STATES.filter((state) => legalTargets(state).length === 0);
    expect(sinks).toEqual(["reported"]);
    for (const state of SESSION_STATES) {
      const seen = new Set<string>();
      const stack = [state];
      while (stack.length) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        stack.push(...legalTargets(current as typeof state));
      }
      expect(seen.has("reported")).toBe(true);
    }
  });
});

describe("score, merge, privacy", () => {
  it("caps the score the way the spec describes", () => {
    expect(scoreOf([])).toBe(100);
    const blockers = Array.from({ length: 9 }, () => ({ severity: "blocker" }) as Hotspot);
    expect(scoreOf(blockers)).toBe(40);
  });

  it("merges by control and keeps every finding", () => {
    const sessions = [
      session("skimmer", [finding("skimmer", "silent_failure", "Sign up")]),
      session("keyboard", [finding("keyboard", "unreachable_by_keyboard", "Sign up")]),
    ];
    const hotspots = mergeFindings(sessions);
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]?.id).toBe("F0b8149");
    expect(hotspots[0]?.kinds).toEqual(["silent_failure", "unreachable_by_keyboard"]);
    expect(hotspotDetailCount(hotspots)).toBe(2);
  });

  it("diff lists a cleared hotspot as resolved", () => {
    const hotspot = mergeFindings([session("skimmer", [finding("skimmer", "silent_failure", "Sign up")])])[0];
    if (!hotspot) throw new Error("missing hotspot");
    const before = { hotspots: [hotspot] } as unknown as Run;
    const after = { hotspots: [] } as unknown as Run;
    expect(diffRuns(before, after).resolved.map((item) => item.id)).toEqual([hotspot.id]);
  });

  it("gate codes", () => {
    expect(gateCode(scored(100), 80)).toBe(0);
    expect(gateCode(scored(36), 80)).toBe(1);
    expect(gateCode(inconclusive([personaId("skimmer")]), 80)).toBe(2);
  });

  it("privacy scan catches an email and ignores the bake-sale copy", () => {
    expect(privacyHits("mail me at a.b@example.com", [])).toContain("email");
    expect(privacyHits("Sign up button 12x12px", [])).toEqual([]);
    expect(privacyHits("ssn 123-45-6789", [])).toContain("ssn");
  });

  it("redacts a listed word out of a control key", () => {
    const snap: PageSnapshot = {
      url: "http://127.0.0.1/",
      kind: "form",
      overflowPx: 0,
      redact: ["B7"],
      controls: [
        {
          index: 0,
          tag: "button",
          text: "B7",
          name: "",
          placeholder: "",
          role: "",
          key: controlKey("B7"),
          href: "",
          visible: true,
          clickOnly: false,
          type: "",
          box: { x: 0, y: 0, w: 10, h: 10 },
        },
      ],
    };
    const who: Persona = {
      id: personaId("phone"),
      label: "Phone",
      viewport: { w: 375, h: 740 },
      touch: true,
      patienceMs: 2500,
      goal: "tap",
      checks: ["tiny_tap_target"],
    };
    const text = JSON.stringify(phone(snap, who));
    expect(text).not.toContain("B7");
    expect(text).toContain("[name]");
  });

  it("does not treat a closed-section control as unnamed when it is already filtered", () => {
    const snap: PageSnapshot = {
      url: "http://127.0.0.1/",
      kind: "form",
      overflowPx: 0,
      redact: [],
      controls: [
        {
          index: 0,
          tag: "button",
          text: "Add item",
          name: "",
          placeholder: "",
          role: "",
          key: controlKey("Add item"),
          href: "",
          visible: true,
          clickOnly: false,
          type: "",
          box: { x: 0, y: 0, w: 80, h: 40 },
        },
      ],
    };
    const who: Persona = {
      id: personaId("screenreader"),
      label: "Screen reader",
      viewport: { w: 1280, h: 800 },
      touch: false,
      patienceMs: 3000,
      goal: "names",
      checks: ["unnamed_control", "unlabeled_field", "fake_button"],
    };
    expect(screenreader(snap, who).map((item) => item.kind)).not.toContain("unnamed_control");
  });
});

describe("sweep helpers and the model", () => {
  it("groups near-duplicate apps and leaves empty apps alone", () => {
    const groups = codeGroups(join(repo, "tests", "fixtures", "o3"), ["a", "b", "c", "d"]);
    const members = Object.values(groups);
    expect(members).toHaveLength(1);
    expect(members[0]?.slice().sort()).toEqual(["a", "b"]);
  });

  it("reads a README frl-start hint", () => {
    const hint = startHint(join(repo, "tests", "fixtures", "o4", "pyapp"), {});
    expect(hint).toContain("--demo");
  });

  it("loads a persona file without new check code", () => {
    const persona = personaFromJson(JSON.parse(readFileSync(join(repo, "personas", "tablet-kid.json"), "utf8")));
    expect(persona.id).toBe("tablet-kid");
    expect(persona.viewport).toEqual({ w: 1024, h: 768 });
    expect(persona.touch).toBe(true);
    expect(persona.patienceMs).toBe(4000);
    expect(persona.checks).toContain("tiny_tap_target");
  });

  it("the TLA+ model lists every table edge, and the mutant drops crashed to reported", () => {
    const model = renderSessionTla();
    expect(model).toContain('"crashed" -> {"reported"}');
    expect(model).toContain("I1 ==");
    expect(model).toContain("I6 ==");
    const mutant = renderSessionTla({ drop: [["crashed", "reported"]] });
    expect(mutant).toContain('"crashed" -> {}');
    expect(mutant).not.toContain('"crashed" -> {"reported"}');
  });

  it("source has no explicit any", () => {
    const files = walk(join(repo, "ts", "src")).concat(walk(join(repo, "ts", "test")));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/(:|\bas\b|<)\s*any\b|\bany\[\]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (name.endsWith(".ts")) acc.push(full);
    else {
      try {
        if (readdirSync(full)) walk(full, acc);
      } catch {
        /* file */
      }
    }
  }
  return acc;
}
