export type PersonaId = string & { __brand: "PersonaId" };
export type ControlKey = string & { __brand: "ControlKey" };
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

export interface Frame {
  shot: string;
  caption: string;
}

export interface Transition {
  from: string;
  to: string;
  why: string;
  atMs: number;
}

export interface Session {
  persona: PersonaId;
  label: string;
  state: string;
  log: Transition[];
  findings: Finding[];
  frames: Frame[];
  steps: number;
  error?: string;
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

export interface Run {
  schema: 1;
  id: string;
  url: string;
  startedAt: string;
  kind: "form" | "dashboard";
  sessions: Session[];
  hotspots: Hotspot[];
  verdict: Verdict;
  blocked: string[];
  runLog: Transition[];
}

export interface Control {
  i: number;
  tag: string;
  text: string;
  name: string;
  placeholder: string;
  role: string;
  key: string;
  w: number;
  h: number;
  x: number;
  y: number;
  href: string;
  vis: boolean;
  clickOnly: boolean;
}
