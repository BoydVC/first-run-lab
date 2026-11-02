/**
 * First-Run Lab data model (spec v1.3.2 §4, plus the finding kinds and
 * unscored verdicts added in §13–§15). This module is the contract:
 * constructors and exhaustive switches only, no browser behavior.
 */

declare const personaBrand: unique symbol;
declare const controlBrand: unique symbol;

export type PersonaId = string & { readonly [personaBrand]: "PersonaId" };
export type ControlKey = string & { readonly [controlBrand]: "ControlKey" };

const PERSONA_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function personaId(raw: string): PersonaId {
  if (!PERSONA_RE.test(raw)) throw new Error(`bad persona id: ${raw}`);
  return raw as PersonaId;
}

/** Accessible-name key, first line, 30 characters. Empty becomes "control". */
export function controlKey(raw: string): ControlKey {
  const line = raw.split("\n")[0] ?? "";
  const trimmed = line.trim().slice(0, 30);
  return (trimmed.length > 0 ? trimmed : "control") as ControlKey;
}

export type Severity = "blocker" | "major" | "minor";

/**
 * §3 kinds, plus `unclickable_cta` (§13) and `broken_api` (§15).
 * The §4 alias predates those two; they are part of the v1.3.2 contract.
 */
export const FINDING_KINDS = [
  "no_clear_cta",
  "silent_failure",
  "slow_or_no_confirmation",
  "unreachable_by_keyboard",
  "invisible_focus",
  "tiny_tap_target",
  "small_tap_target",
  "horizontal_scroll",
  "unnamed_control",
  "unlabeled_field",
  "fake_button",
  "dead_link",
  "unclickable_cta",
  "broken_api",
  "form_redraws_while_typing",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];

export function isFindingKind(value: string): value is FindingKind {
  return (FINDING_KINDS as readonly string[]).includes(value);
}

export const SEVERITY_RANK: Record<Severity, number> = { blocker: 3, major: 2, minor: 1 };

export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}

/** Default severity. Dashboard mode downgrades `no_clear_cta` at the call site. */
export function baseSeverity(kind: FindingKind): Severity {
  switch (kind) {
    case "silent_failure":
    case "unreachable_by_keyboard":
    case "unnamed_control":
      return "blocker";
    case "no_clear_cta":
    case "slow_or_no_confirmation":
    case "invisible_focus":
    case "tiny_tap_target":
    case "unlabeled_field":
    case "fake_button":
    case "dead_link":
    case "unclickable_cta":
    case "broken_api":
    case "form_redraws_while_typing":
      return "major";
    case "small_tap_target":
    case "horizontal_scroll":
      return "minor";
    default:
      return assertNever(kind);
  }
}

export function describeKind(kind: FindingKind): string {
  switch (kind) {
    case "no_clear_cta":
      return "No clear call to action";
    case "silent_failure":
      return "Silent failure";
    case "slow_or_no_confirmation":
      return "Slow or missing confirmation";
    case "unreachable_by_keyboard":
      return "Unreachable by keyboard";
    case "invisible_focus":
      return "Invisible focus";
    case "tiny_tap_target":
      return "Tiny tap target";
    case "small_tap_target":
      return "Small tap target";
    case "horizontal_scroll":
      return "Horizontal scroll";
    case "unnamed_control":
      return "Unnamed control";
    case "unlabeled_field":
      return "Unlabeled field";
    case "fake_button":
      return "Fake button";
    case "dead_link":
      return "Dead link";
    case "form_redraws_while_typing":
      return "Form redraws while typing";
    case "unclickable_cta":
      return "Unclickable call to action";
    case "broken_api":
      return "Broken API";
    default:
      return assertNever(kind);
  }
}

export interface Persona {
  id: PersonaId;
  label: string;
  viewport: { w: number; h: number };
  touch: boolean;
  patienceMs: number;
  goal: string;
  checks: FindingKind[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Finding {
  persona: PersonaId;
  kind: FindingKind;
  severity: Severity;
  control: ControlKey | "page";
  detail: string;
  evidence: { shot: string; box?: Box };
  step: number;
}

export const SESSION_STATES = [
  "queued",
  "launching",
  "exploring",
  "stuck",
  "done",
  "budget_exhausted",
  "crashed",
  "reported",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export function isSessionState(value: string): value is SessionState {
  return (SESSION_STATES as readonly string[]).includes(value);
}

export function describeState(state: SessionState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "launching":
      return "Launching";
    case "exploring":
      return "Exploring";
    case "stuck":
      return "Stuck";
    case "done":
      return "Done";
    case "budget_exhausted":
      return "Budget exhausted";
    case "crashed":
      return "Crashed";
    case "reported":
      return "Reported";
    default:
      return assertNever(state);
  }
}

/** Reported is the only sink. Every other state still has work to do. */
export function isSink(state: SessionState): boolean {
  switch (state) {
    case "queued":
    case "launching":
    case "exploring":
    case "stuck":
    case "done":
    case "budget_exhausted":
    case "crashed":
      return false;
    case "reported":
      return true;
    default:
      return assertNever(state);
  }
}

export interface Transition {
  from: SessionState;
  to: SessionState;
  why: string;
  atMs: number;
}

export interface Frame {
  shot: string;
  caption: string;
}

export interface Session {
  persona: PersonaId;
  state: SessionState;
  log: Transition[];
  findings: Finding[];
  frames: Frame[];
  steps: number;
}

export type HotspotId = `F${string}`;

export interface Hotspot {
  id: HotspotId;
  control: ControlKey | "page";
  severity: Severity;
  kinds: FindingKind[];
  personas: PersonaId[];
  details: string[];
  evidence: Finding["evidence"];
}

/**
 * A scored verdict has a score and no crashed list.
 * `crashed` is not a field of the scored variant, so "scored while a
 * session crashed" cannot be written as a Verdict.
 * `unreachable` and `needs_backend` (§13, §15) are unscored siblings.
 */
export type Verdict =
  | { readonly kind: "scored"; readonly score: number }
  | { readonly kind: "inconclusive"; readonly crashed: readonly PersonaId[] }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "needs_backend"; readonly detail: string };

export function scored(score: number): Verdict {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error(`score out of range: ${score}`);
  }
  return { kind: "scored", score };
}

export function inconclusive(crashed: readonly PersonaId[]): Verdict {
  if (crashed.length === 0) throw new Error("inconclusive requires a crashed persona");
  return { kind: "inconclusive", crashed: [...crashed] };
}

export function unreachable(detail: string): Verdict {
  return { kind: "unreachable", detail };
}

export function needsBackend(detail: string): Verdict {
  return { kind: "needs_backend", detail };
}

export type PageKind = "form" | "dashboard";

export interface Run {
  schema: 1;
  id: string;
  url: string;
  startedAt: string;
  /** §13: the report carries the detected page kind. */
  kind: PageKind;
  sessions: Session[];
  hotspots: Hotspot[];
  verdict: Verdict;
  /** §6 / AT9: cross-origin requests aborted at the network layer. */
  blocked: string[];
}

export type ScoredVerdict = Extract<Verdict, { kind: "scored" }>;

/**
 * Compile-time witness: the scored variant has no `crashed` field.
 * If a future edit adds one, this alias becomes `never` and the
 * assignment in proof.ts fails.
 */
export type ScoredCrashUnrepresentable = "crashed" extends keyof ScoredVerdict ? never : true;
