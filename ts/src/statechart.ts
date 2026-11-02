/**
 * Session statechart. The transition table is the single source for the
 * runtime checker, the typed edge helper, the dashboard, and the TLA+ model.
 */
import {
  SESSION_STATES,
  describeState,
  isSink,
  type Session,
  type SessionState,
  type Transition,
} from "./types.js";

export const TRANSITION_TABLE = {
  queued: { launching: "start" },
  launching: { exploring: "loaded", crashed: "error" },
  exploring: {
    exploring: "step",
    stuck: "gave_up",
    done: "checks_complete",
    budget_exhausted: "budget",
    crashed: "error",
  },
  stuck: { reported: "report" },
  done: { reported: "report" },
  budget_exhausted: { reported: "report" },
  crashed: { reported: "report" },
  reported: {},
} as const satisfies Record<SessionState, Partial<Record<SessionState, string>>>;

export type LegalTarget<S extends SessionState> = keyof (typeof TRANSITION_TABLE)[S] & string;

export class IllegalTransitionError extends Error {
  readonly from: SessionState;
  readonly to: SessionState;
  constructor(from: SessionState, to: SessionState) {
    super(`illegal ${from}->${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function legalTargets(from: SessionState): SessionState[] {
  return Object.keys(TRANSITION_TABLE[from]) as SessionState[];
}

/** Runtime guard. Throws on every edge that is not in the table. */
export function assertLegalEdge(from: SessionState, to: SessionState): string {
  const row = TRANSITION_TABLE[from] as Partial<Record<SessionState, string>>;
  const why = row[to];
  if (why === undefined) throw new IllegalTransitionError(from, to);
  return why;
}

/**
 * Compile-time edge. `to` must be a legal successor of a literal `from`,
 * so `edge("queued", "reported", ...)` is a type error. Dynamic states
 * still go through {@link apply}, which throws.
 */
export function edge<S extends SessionState>(
  from: S,
  to: LegalTarget<S>,
  why: string,
  atMs: number,
): Transition {
  assertLegalEdge(from, to as SessionState);
  return { from, to: to as SessionState, why, atMs };
}

export function createSession(persona: Session["persona"]): Session {
  return { persona, state: "queued", log: [], findings: [], frames: [], steps: 0 };
}

/**
 * Advance a session. Illegal edges throw. `stuck` with zero steps throws
 * (invariant I4) instead of being recorded.
 */
export function apply(session: Session, to: SessionState, why: string, atMs: number): Session {
  assertLegalEdge(session.state, to);
  const steps = session.state === "exploring" && to === "exploring" ? session.steps + 1 : session.steps;
  if (to === "stuck" && steps < 1) {
    throw new Error("I4: stuck only after at least one step");
  }
  const transition: Transition = { from: session.state, to, why, atMs };
  return { ...session, state: to, steps, log: [...session.log, transition] };
}

/** State before the `reported` edge. Null when the session has not reported. */
export function preReport(session: Session): SessionState | null {
  for (let i = session.log.length - 1; i >= 0; i -= 1) {
    const step = session.log[i];
    if (step && step.to === "reported") return step.from;
  }
  return null;
}

export function statechartLines(): string[] {
  const lines: string[] = [];
  for (const state of SESSION_STATES) {
    const targets = legalTargets(state);
    if (targets.length === 0) {
      lines.push(`${state} (${describeState(state)}) is absorbing`);
      continue;
    }
    for (const to of targets) {
      const why = assertLegalEdge(state, to);
      lines.push(`${state} --${why}--> ${to}`);
    }
  }
  return lines;
}

export function statechartMermaid(): string {
  const lines = ["stateDiagram-v2"];
  for (const state of SESSION_STATES) {
    const targets = legalTargets(state);
    if (targets.length === 0 && isSink(state)) {
      lines.push(`  ${state} --> [*]`);
      continue;
    }
    for (const to of targets) {
      lines.push(`  ${state} --> ${to}: ${assertLegalEdge(state, to)}`);
    }
  }
  return lines.join("\n");
}
