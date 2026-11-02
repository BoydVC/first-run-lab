import fs from "node:fs";
import path from "node:path";
import type { FindingKind, Persona, PersonaId } from "./types.ts";

const KINDS = new Set<FindingKind>([
  "no_clear_cta", "silent_failure", "slow_or_no_confirmation", "unreachable_by_keyboard",
  "invisible_focus", "tiny_tap_target", "small_tap_target", "horizontal_scroll",
  "unnamed_control", "unlabeled_field", "fake_button", "dead_link", "unclickable_cta", "broken_api",
]);

export const BUILTIN: Persona[] = [
  {
    id: "skimmer" as PersonaId, label: "Skimmer", viewport: { w: 1280, h: 800 }, touch: false,
    patienceMs: 2000, goal: "complete the main call to action",
    checks: ["no_clear_cta", "silent_failure", "slow_or_no_confirmation"],
  },
  {
    id: "keyboard" as PersonaId, label: "Keyboard-only", viewport: { w: 1280, h: 800 }, touch: false,
    patienceMs: 3000, goal: "reach every control with Tab",
    checks: ["unreachable_by_keyboard", "invisible_focus"],
  },
  {
    id: "phone" as PersonaId, label: "Phone thumb", viewport: { w: 375, h: 740 }, touch: true,
    patienceMs: 2500, goal: "use it one-handed on a phone",
    checks: ["tiny_tap_target", "small_tap_target", "horizontal_scroll"],
  },
  {
    id: "screenreader" as PersonaId, label: "Screen reader", viewport: { w: 1280, h: 800 }, touch: false,
    patienceMs: 3000, goal: "understand every control by its name",
    checks: ["unnamed_control", "unlabeled_field", "fake_button"],
  },
  {
    id: "curious" as PersonaId, label: "Curious clicker", viewport: { w: 1280, h: 800 }, touch: false,
    patienceMs: 3000, goal: "open every link",
    checks: ["dead_link"],
  },
];

function asPersona(raw: Partial<Persona>): Persona {
  if (!raw.id || !raw.viewport || !raw.checks) throw new Error("persona JSON needs id, viewport, and checks");
  for (const c of raw.checks) {
    if (!KINDS.has(c)) throw new Error(`persona ${raw.id} has unknown check ${c}`);
  }
  return {
    id: raw.id as PersonaId,
    label: raw.label || raw.id,
    viewport: { w: Number(raw.viewport.w), h: Number(raw.viewport.h) },
    touch: !!raw.touch,
    patienceMs: Number(raw.patienceMs ?? 3000),
    goal: raw.goal || "",
    checks: raw.checks,
  };
}

export function loadPersonas(dir: string, only?: string[]): Persona[] {
  const extras: Persona[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      extras.push(asPersona(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))));
    }
  }
  const byId = new Map<string, Persona>();
  for (const p of BUILTIN) byId.set(p.id, p);
  for (const p of extras) byId.set(p.id, p);
  const all = [...byId.values()];
  if (!only?.length) return BUILTIN.concat(extras.filter((p) => !BUILTIN.some((b) => b.id === p.id)));
  return only.map((id) => {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`unknown persona ${id}`);
    return p;
  });
}
