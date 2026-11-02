------------------------------ MODULE Session ------------------------------
\* Generated from ts/src/statechart.ts. Do not edit by hand.
\* queued -> launching:start
\* launching -> exploring:loaded, crashed:error
\* exploring -> exploring:step, stuck:gave_up, done:checks_complete, budget_exhausted:budget, crashed:error
\* stuck -> reported:report
\* done -> reported:report
\* budget_exhausted -> reported:report
\* crashed -> reported:report
\* reported absorbing
EXTENDS Naturals, FiniteSets

MaxSteps == 2
MaxFindings == 2

States == {"queued", "launching", "exploring", "stuck", "done", "budget_exhausted", "crashed", "reported"}

NextState(s) ==
  CASE FALSE -> {}
    [] s = "queued" -> {"launching"}
    [] s = "launching" -> {"exploring", "crashed"}
    [] s = "exploring" -> {"exploring", "stuck", "done", "budget_exhausted", "crashed"}
    [] s = "stuck" -> {"reported"}
    [] s = "done" -> {"reported"}
    [] s = "budget_exhausted" -> {"reported"}
    [] s = "crashed" -> {"reported"}
    [] s = "reported" -> {}
    [] OTHER -> {}

VARIABLES state, steps, preReport, nFindings, nHotspot, verdict, lastFrom, lastTo

vars == <<state, steps, preReport, nFindings, nHotspot, verdict, lastFrom, lastTo>>

Init ==
  /\ state = "queued"
  /\ steps = 0
  /\ preReport = ""
  /\ nFindings = 0
  /\ nHotspot = 0
  /\ verdict = "pending"
  /\ lastFrom = ""
  /\ lastTo = ""

Can(nxt) ==
  /\ nxt \in NextState(state)
  /\ (nxt # "stuck" \/ steps >= 1)
  /\ ~(state = "exploring" /\ nxt = "exploring" /\ steps >= MaxSteps)

Move(nxt) ==
  /\ Can(nxt)
  /\ lastFrom' = state
  /\ lastTo' = nxt
  /\ state' = nxt
  /\ steps' = IF state = "exploring" /\ nxt = "exploring" THEN steps + 1 ELSE steps
  /\ preReport' = IF nxt = "reported" THEN state ELSE preReport
  /\ nFindings' = IF state = "exploring" /\ nxt = "exploring" /\ nFindings < MaxFindings
                  THEN nFindings + 1
                  ELSE nFindings
  /\ nHotspot' = IF nxt = "reported" THEN nFindings ELSE nHotspot
  /\ verdict' = verdict

Score ==
  /\ state = "reported"
  /\ verdict = "pending"
  /\ verdict' = IF preReport = "crashed" THEN "inconclusive" ELSE "scored"
  /\ UNCHANGED <<state, steps, preReport, nFindings, nHotspot, lastFrom, lastTo>>

\* The reported sink stays enabled so TLC does not call it a deadlock.
Done ==
  /\ state = "reported"
  /\ verdict # "pending"
  /\ UNCHANGED vars

Next ==
  \/ \E nxt \in States : Move(nxt)
  \/ Score
  \/ Done

Start == state = "queued" /\ Move("launching")
Loaded == state = "launching" /\ \E nxt \in NextState("launching") : Move(nxt)
Leave == state = "exploring" /\ \E nxt \in {"done", "budget_exhausted", "crashed", "stuck"} : Move(nxt)
Report == state \in {"stuck", "done", "budget_exhausted", "crashed"} /\ Move("reported")

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(Start)
  /\ WF_vars(Loaded)
  /\ WF_vars(Leave)
  /\ WF_vars(Report)
  /\ WF_vars(Score)

\* I1 liveness under fairness: every session reaches reported.
I1 == <>(state = "reported")
\* I2 reported is absorbing.
I2 == [](state = "reported" => [](state = "reported"))
\* I3 a scored verdict never follows a crashed pre-report state.
I3 == verdict = "scored" => preReport # "crashed"
\* I4 stuck happens only after at least one step.
I4 == state = "stuck" => steps >= 1
\* I5 no recorded transition sits outside the table.
I5 == lastFrom = "" \/ lastTo \in NextState(lastFrom)
\* I6 merge loses nothing: hotspot findings equal session findings.
I6 == state = "reported" => nHotspot = nFindings

TypeOK ==
  /\ state \in States
  /\ steps \in 0..MaxSteps
  /\ preReport \in ({""} \cup States)
  /\ nFindings \in 0..MaxFindings
  /\ nHotspot \in 0..MaxFindings
  /\ verdict \in {"pending", "scored", "inconclusive"}
  /\ lastFrom \in ({""} \cup States)
  /\ lastTo \in ({""} \cup States)

=============================================================================
