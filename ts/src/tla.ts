/**
 * Render a TLA+ model from {@link TRANSITION_TABLE}. TLC checks I1–I6.
 * Exploring self-loops are bounded by MaxSteps so the state space is finite;
 * that bound is the same idea as the engine's step budget.
 */
import { SESSION_STATES, type SessionState } from "./types.js";
import { TRANSITION_TABLE, legalTargets } from "./statechart.js";

export interface TlaOptions {
  /** Edges removed from the table. The crashed→reported mutant fails I1. */
  drop?: readonly (readonly [SessionState, SessionState])[];
  maxSteps?: number;
  maxFindings?: number;
}

function targetsOf(state: SessionState, drop: readonly (readonly [SessionState, SessionState])[]): SessionState[] {
  return legalTargets(state).filter((to) => !drop.some(([from, dst]) => from === state && dst === to));
}

function quote(state: string): string {
  return `"${state}"`;
}

export function renderSessionTla(opts: TlaOptions = {}): string {
  const drop = opts.drop ?? [];
  const maxSteps = opts.maxSteps ?? 2;
  const maxFindings = opts.maxFindings ?? 2;
  const setLiteral = SESSION_STATES.map((s) => quote(s)).join(", ");
  const cases = SESSION_STATES.map((state) => {
    const targets = targetsOf(state, drop);
    const body = targets.length === 0 ? "{}" : `{${targets.map(quote).join(", ")}}`;
    return `    [] s = ${quote(state)} -> ${body}`;
  }).join("\n");

  const tableComment = SESSION_STATES.map((state) => {
    const row = TRANSITION_TABLE[state] as Partial<Record<SessionState, string>>;
    const parts = legalTargets(state).map((to) => `${to}:${row[to] ?? ""}`);
    return parts.length === 0 ? `\\* ${state} absorbing` : `\\* ${state} -> ${parts.join(", ")}`;
  }).join("\n");

  return `------------------------------ MODULE Session ------------------------------
\\* Generated from ts/src/statechart.ts. Do not edit by hand.
${tableComment}
EXTENDS Naturals, FiniteSets

MaxSteps == ${maxSteps}
MaxFindings == ${maxFindings}

States == {${setLiteral}}

NextState(s) ==
  CASE FALSE -> {}
${cases}
    [] OTHER -> {}

VARIABLES state, steps, preReport, nFindings, nHotspot, verdict, lastFrom, lastTo

vars == <<state, steps, preReport, nFindings, nHotspot, verdict, lastFrom, lastTo>>

Init ==
  /\\ state = "queued"
  /\\ steps = 0
  /\\ preReport = ""
  /\\ nFindings = 0
  /\\ nHotspot = 0
  /\\ verdict = "pending"
  /\\ lastFrom = ""
  /\\ lastTo = ""

Can(nxt) ==
  /\\ nxt \\in NextState(state)
  /\\ (nxt # "stuck" \\/ steps >= 1)
  /\\ ~(state = "exploring" /\\ nxt = "exploring" /\\ steps >= MaxSteps)

Move(nxt) ==
  /\\ Can(nxt)
  /\\ lastFrom' = state
  /\\ lastTo' = nxt
  /\\ state' = nxt
  /\\ steps' = IF state = "exploring" /\\ nxt = "exploring" THEN steps + 1 ELSE steps
  /\\ preReport' = IF nxt = "reported" THEN state ELSE preReport
  /\\ nFindings' = IF state = "exploring" /\\ nxt = "exploring" /\\ nFindings < MaxFindings
                  THEN nFindings + 1
                  ELSE nFindings
  /\\ nHotspot' = IF nxt = "reported" THEN nFindings ELSE nHotspot
  /\\ verdict' = verdict

Score ==
  /\\ state = "reported"
  /\\ verdict = "pending"
  /\\ verdict' = IF preReport = "crashed" THEN "inconclusive" ELSE "scored"
  /\\ UNCHANGED <<state, steps, preReport, nFindings, nHotspot, lastFrom, lastTo>>

\\* The reported sink stays enabled so TLC does not call it a deadlock.
Done ==
  /\\ state = "reported"
  /\\ verdict # "pending"
  /\\ UNCHANGED vars

Next ==
  \\/ \\E nxt \\in States : Move(nxt)
  \\/ Score
  \\/ Done

Start == state = "queued" /\\ Move("launching")
Loaded == state = "launching" /\\ \\E nxt \\in NextState("launching") : Move(nxt)
Leave == state = "exploring" /\\ \\E nxt \\in {"done", "budget_exhausted", "crashed", "stuck"} : Move(nxt)
Report == state \\in {"stuck", "done", "budget_exhausted", "crashed"} /\\ Move("reported")

Spec ==
  /\\ Init
  /\\ [][Next]_vars
  /\\ WF_vars(Start)
  /\\ WF_vars(Loaded)
  /\\ WF_vars(Leave)
  /\\ WF_vars(Report)
  /\\ WF_vars(Score)

\\* I1 liveness under fairness: every session reaches reported.
I1 == <>(state = "reported")
\\* I2 reported is absorbing.
I2 == [](state = "reported" => [](state = "reported"))
\\* I3 a scored verdict never follows a crashed pre-report state.
I3 == verdict = "scored" => preReport # "crashed"
\\* I4 stuck happens only after at least one step.
I4 == state = "stuck" => steps >= 1
\\* I5 no recorded transition sits outside the table.
I5 == lastFrom = "" \\/ lastTo \\in NextState(lastFrom)
\\* I6 merge loses nothing: hotspot findings equal session findings.
I6 == state = "reported" => nHotspot = nFindings

TypeOK ==
  /\\ state \\in States
  /\\ steps \\in 0..MaxSteps
  /\\ preReport \\in ({""} \\cup States)
  /\\ nFindings \\in 0..MaxFindings
  /\\ nHotspot \\in 0..MaxFindings
  /\\ verdict \\in {"pending", "scored", "inconclusive"}
  /\\ lastFrom \\in ({""} \\cup States)
  /\\ lastTo \\in ({""} \\cup States)

=============================================================================
`;
}

export function renderMcCfg(): string {
  return `SPECIFICATION Spec
PROPERTY I1
PROPERTY I2
INVARIANT I3
INVARIANT I4
INVARIANT I5
INVARIANT I6
INVARIANT TypeOK
`;
}
