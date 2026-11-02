import type { Session, SessionState, Transition } from "./types.js";

/** Single source of truth for the session statechart (§5). The dashboard and the TLA+ model mirror this table. */
export const TRANSITIONS: Record<SessionState, { to: SessionState; why: string }[]> = {
  queued: [{ to: "launching", why: "start" }],
  launching: [
    { to: "exploring", why: "loaded" },
    { to: "crashed", why: "error" },
  ],
  exploring: [
    { to: "exploring", why: "step" },
    { to: "stuck", why: "gave_up" },
    { to: "done", why: "checks_complete" },
    { to: "budget_exhausted", why: "steps ≥ budget" },
    { to: "crashed", why: "error" },
  ],
  stuck: [{ to: "reported", why: "report" }],
  done: [{ to: "reported", why: "report" }],
  budget_exhausted: [{ to: "reported", why: "report" }],
  crashed: [{ to: "reported", why: "report" }],
  reported: [],
};

export const STATES = Object.keys(TRANSITIONS) as SessionState[];

export function allowed(from: SessionState): SessionState[] {
  return TRANSITIONS[from].map((e) => e.to);
}

export function can(from: SessionState, to: SessionState): boolean {
  return allowed(from).includes(to);
}

export function createSession(persona: string): Session {
  return { persona, state: "queued", log: [], findings: [], frames: [], steps: 0 };
}

/** Illegal edges throw (I5). `stuck` is only entered by the caller after at least one step (I4). */
export function go(session: Session, to: SessionState, why: string, atMs = Date.now()): void {
  if (!can(session.state, to)) {
    throw new Error(`illegal ${session.state}->${to}`);
  }
  const edge: Transition = { from: session.state, to, why, atMs };
  session.log.push(edge);
  session.state = to;
}

export function preReport(session: Session): SessionState {
  for (let i = session.log.length - 1; i >= 0; i--) {
    if (session.log[i].to === "reported") return session.log[i].from;
  }
  return session.state;
}
