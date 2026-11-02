import { assertRun, assertSession, type SessionState } from "./statechart.generated.ts";
import type { Transition } from "./types.ts";

/** Replay a session log against the generated table. Throws on any illegal step. */
export function replaySession(log: Transition[]): SessionState {
  if (!log.length) throw new Error("empty session log");
  let state = "queued";
  for (const step of log) {
    if (step.from !== state) throw new Error(`log says ${step.from} but the session is ${state}`);
    assertSession(step.from, step.to, step.why);
    state = step.to;
  }
  if (state !== "reported") throw new Error(`session ended in ${state}, not reported`);
  return state as SessionState;
}

export function replayRun(log: Transition[]): void {
  if (!log.length) throw new Error("empty run log");
  let state = "idle";
  for (const step of log) {
    if (step.from !== state) throw new Error(`run log says ${step.from} but phase is ${state}`);
    assertRun(step.from, step.to, step.why);
    state = step.to;
  }
}
