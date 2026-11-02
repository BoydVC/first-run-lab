/** Contract types from spec §4, plus the §13–15 verdicts and finding kinds. */

export type PersonaId = string;
export type ControlKey = string;
export type Severity = "blocker" | "major" | "minor";

export type FindingKind =
  | "no_clear_cta"
  | "silent_failure"
  | "slow_or_no_confirmation"
  | "unreachable_by_keyboard"
  | "invisible_focus"
  | "tiny_tap_target"
  | "small_tap_target"
  | "horizontal_scroll"
  | "unnamed_control"
  | "unlabeled_field"
  | "fake_button"
  | "dead_link"
  | "unclickable_cta"
  | "broken_api";

export interface Persona {
  id: PersonaId;
  label: string;
  viewport: { w: number; h: number };
  touch: boolean;
  patienceMs: number;
  goal: string;
  checks: FindingKind[];
}

export interface Finding {
  persona: PersonaId;
  kind: FindingKind;
  severity: Severity;
  control: ControlKey | "page";
  detail: string;
  evidence: { shot: string; box?: { x: number; y: number; w: number; h: number } };
  step: number;
}

export type SessionState =
  | "queued"
  | "launching"
  | "exploring"
  | "stuck"
  | "done"
  | "budget_exhausted"
  | "crashed"
  | "reported";

export interface Transition {
  from: SessionState;
  to: SessionState;
  why: string;
  atMs: number;
}

export interface Session {
  persona: PersonaId;
  state: SessionState;
  log: Transition[];
  findings: Finding[];
  frames: { shot: string; caption: string }[];
  steps: number;
}

export interface Hotspot {
  id: `F${string}`;
  control: ControlKey | "page";
  severity: Severity;
  kinds: FindingKind[];
  personas: PersonaId[];
  details: string[];
  evidence: Finding["evidence"];
}

export type Verdict =
  | { kind: "scored"; score: number }
  | { kind: "inconclusive"; crashed: PersonaId[] }
  | { kind: "unreachable"; detail: string }
  | { kind: "needs_backend"; detail: string };

export type PageKind = "form" | "dashboard";

export interface Run {
  schema: 1;
  id: string;
  url: string;
  startedAt: string;
  kind: PageKind;
  sessions: Session[];
  hotspots: Hotspot[];
  verdict: Verdict;
  blocked: string[];
}

export interface Control {
  i: number;
  tag: string;
  text: string;
  name: string;
  placeholder: string;
  role: string;
  key: string;
  tabindex: number;
  w: number;
  h: number;
  x: number;
  y: number;
  href: string;
  vis: boolean;
  clickOnly: boolean;
  type: string;
}
