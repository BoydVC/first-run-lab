/**
 * Persona checks are pure: (page snapshot, persona) => findings.
 * The driver in observe.ts fills the snapshot; these functions do not touch a browser.
 */
import type { Control } from "./snapshot.js";
import type { PageSnapshot } from "./snapshot.js";
import {
  baseSeverity,
  controlKey,
  personaId,
  type Finding,
  type FindingKind,
  type PageKind,
  type Persona,
  type Severity,
} from "./types.js";

export const BUILTIN_PERSONAS: readonly Persona[] = [
  {
    id: personaId("skimmer"),
    label: "Skimmer",
    viewport: { w: 1280, h: 800 },
    touch: false,
    patienceMs: 2000,
    goal: "complete the main call to action",
    checks: ["no_clear_cta", "silent_failure", "slow_or_no_confirmation", "unclickable_cta", "form_redraws_while_typing"],
  },
  {
    id: personaId("keyboard"),
    label: "Keyboard-only",
    viewport: { w: 1280, h: 800 },
    touch: false,
    patienceMs: 3000,
    goal: "reach every control with Tab",
    checks: ["unreachable_by_keyboard", "invisible_focus"],
  },
  {
    id: personaId("phone"),
    label: "Phone thumb",
    viewport: { w: 375, h: 740 },
    touch: true,
    patienceMs: 2500,
    goal: "use it one-handed on a phone",
    checks: ["tiny_tap_target", "small_tap_target", "horizontal_scroll"],
  },
  {
    id: personaId("screenreader"),
    label: "Screen reader",
    viewport: { w: 1280, h: 800 },
    touch: false,
    patienceMs: 3000,
    goal: "understand every control by its name",
    checks: ["unnamed_control", "unlabeled_field", "fake_button"],
  },
  {
    id: personaId("curious"),
    label: "Link-clicker",
    viewport: { w: 1280, h: 800 },
    touch: false,
    patienceMs: 3000,
    goal: "open every link",
    checks: ["dead_link"],
  },
];

function redact(text: string, words: readonly string[]): string {
  let out = text;
  for (const word of words) {
    const trimmed = word.trim();
    if (!trimmed) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "gi"), "[name]");
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function severityFor(kind: FindingKind, pageKind: PageKind): Severity {
  if (kind === "no_clear_cta" && pageKind === "dashboard") return "minor";
  return baseSeverity(kind);
}

function make(
  persona: Persona,
  page: PageSnapshot,
  kind: FindingKind,
  control: Control["key"] | "page",
  detail: string,
  step: number,
  box?: Control["box"],
): Finding {
  const redactedControl = control === "page" ? "page" : controlKey(redact(control, page.redact));
  const evidence = box ? { shot: "", box } : { shot: "" };
  return {
    persona: persona.id,
    kind,
    severity: severityFor(kind, page.kind),
    control: redactedControl,
    detail: redact(detail, page.redact),
    evidence,
    step,
  };
}

function boxFor(page: PageSnapshot, key: Control["key"]): Control["box"] | undefined {
  for (const control of page.controls) {
    if (control.visible && control.key === key) return control.box;
  }
  return undefined;
}

export function skimmer(page: PageSnapshot, persona: Persona): Finding[] {
  const obs = page.skimmer;
  if (!obs) return [];
  if (obs.cta === null) {
    const extra = page.kind === "dashboard" ? " (dashboard: read-only is fine)" : "";
    return [make(persona, page, "no_clear_cta", "page", `No obvious primary action found${extra}`, 0)];
  }
  const box = boxFor(page, obs.cta);
  if (obs.unclickable) {
    return [
      make(
        persona,
        page,
        "unclickable_cta",
        obs.cta,
        "Main action can't be clicked: something covers it or it never stops moving",
        1,
        box,
      ),
    ];
  }
  const out: Finding[] = [];
  if (obs.emptyMs === null) {
    out.push(
      make(
        persona,
        page,
        "silent_failure",
        obs.cta,
        "Clicked the main action with empty fields: nothing happened, no error",
        1,
        box,
      ),
    );
  }
  if (!obs.secondSkipped && obs.filledMs === null) {
    out.push(
      make(
        persona,
        page,
        "slow_or_no_confirmation",
        obs.cta,
        `No confirmation within ${persona.patienceMs} ms`,
        2,
        box,
      ),
    );
  }
  if (obs.redrawKey) {
    out.push(
      make(
        persona,
        page,
        "form_redraws_while_typing",
        obs.redrawKey,
        "A field kept being re-drawn while it was being filled in",
        2,
        boxFor(page, obs.redrawKey),
      ),
    );
  }
  return out;
}

export function keyboard(page: PageSnapshot, persona: Persona): Finding[] {
  const obs = page.keyboard;
  if (!obs) return [];
  const out: Finding[] = [];
  if (obs.noFocus.length > 0) {
    out.push(make(persona, page, "invisible_focus", "page", `${obs.noFocus.length} controls show no focus ring`, 1));
  }
  const reached = new Set(obs.reached);
  for (const control of page.controls) {
    if (!control.visible) continue;
    if (!reached.has(control.index)) {
      out.push(
        make(persona, page, "unreachable_by_keyboard", control.key, "Control can't be reached with Tab", 1, control.box),
      );
    }
  }
  return out;
}

export function phone(page: PageSnapshot, persona: Persona): Finding[] {
  const out: Finding[] = [];
  if (page.overflowPx > 4) {
    out.push(
      make(persona, page, "horizontal_scroll", "page", `Page is ${page.overflowPx}px wider than the phone screen`, 1),
    );
  }
  for (const control of page.controls) {
    if (!control.visible || !control.box.w || control.tag === "a") continue;
    const minor = Math.min(control.box.w, control.box.h);
    const w = Math.trunc(control.box.w);
    const h = Math.trunc(control.box.h);
    if (minor < 24) {
      out.push(
        make(
          persona,
          page,
          "tiny_tap_target",
          control.key,
          `${w}x${h}px, under WCAG 2.5.8's 24px`,
          1,
          control.box,
        ),
      );
    } else if ((minor < 44 && control.tag === "button") || (minor < 44 && control.clickOnly)) {
      out.push(
        make(
          persona,
          page,
          "small_tap_target",
          control.key,
          `${w}x${h}px, under the 44px comfort size`,
          1,
          control.box,
        ),
      );
    }
  }
  return out;
}

function readableName(control: Control): string {
  if (control.name) return control.name;
  if (control.tag === "a" || control.tag === "button" || control.clickOnly || control.role === "button") {
    return control.text;
  }
  return "";
}

export function screenreader(page: PageSnapshot, persona: Persona): Finding[] {
  const out: Finding[] = [];
  for (const control of page.controls) {
    if (!control.visible) continue;
    const name = readableName(control);
    if ((control.tag === "input" || control.tag === "select") && !control.name) {
      out.push(
        make(
          persona,
          page,
          "unlabeled_field",
          control.key,
          "Field has no label (placeholder isn't a label)",
          1,
          control.box,
        ),
      );
    } else if (!/[A-Za-z0-9]/.test(name)) {
      out.push(make(persona, page, "unnamed_control", control.key, "Control has no readable name", 1, control.box));
    }
    if (control.clickOnly && !control.role) {
      out.push(
        make(
          persona,
          page,
          "fake_button",
          control.key,
          "Clickable div isn't announced as a button",
          1,
          control.box,
        ),
      );
    }
  }
  return out;
}

export function linkClicker(page: PageSnapshot, persona: Persona): Finding[] {
  const out: Finding[] = [];
  for (const link of page.links ?? []) {
    if (!link.error && link.status < 400) continue;
    const control = page.controls.find((item) => item.index === link.index);
    if (!control) continue;
    const detail = link.error ? `Link fails to load: ${link.error}` : `Link returns HTTP ${link.status}`;
    out.push(make(persona, page, "dead_link", control.key, detail, link.index + 1, control.box));
  }
  return out;
}

export function brokenApi(page: PageSnapshot, persona: Persona): Finding[] {
  return (page.brokenApis ?? []).map((api) =>
    make(persona, page, "broken_api", controlKey(api.path), `App's own API returned ${api.status}`, 1),
  );
}

const CHECK_FN: Record<FindingKind, (page: PageSnapshot, persona: Persona) => Finding[]> = {
  no_clear_cta: skimmer,
  silent_failure: skimmer,
  slow_or_no_confirmation: skimmer,
  unclickable_cta: skimmer,
  unreachable_by_keyboard: keyboard,
  invisible_focus: keyboard,
  tiny_tap_target: phone,
  small_tap_target: phone,
  horizontal_scroll: phone,
  unnamed_control: screenreader,
  unlabeled_field: screenreader,
  fake_button: screenreader,
  dead_link: linkClicker,
  broken_api: brokenApi,
  form_redraws_while_typing: skimmer,
};

/** Run every check the persona lists. Unknown kinds cannot be constructed. */
export function personaFindings(page: PageSnapshot, persona: Persona): Finding[] {
  const fns = new Set<(snap: PageSnapshot, who: Persona) => Finding[]>();
  for (const kind of persona.checks) fns.add(CHECK_FN[kind]);
  const wanted = new Set(persona.checks);
  const found = [...fns].flatMap((fn) => fn(page, persona)).filter((finding) => wanted.has(finding.kind));
  return found.map((finding, index) => ({
    ...finding,
    evidence: { ...finding.evidence, shot: `shots/${persona.id}-${String(index).padStart(2, "0")}.png` },
  }));
}

export function personaById(id: string, extra: readonly Persona[] = []): Persona | undefined {
  return [...BUILTIN_PERSONAS, ...extra].find((persona) => persona.id === id);
}
