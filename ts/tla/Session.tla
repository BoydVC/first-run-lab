------------------------------ MODULE Session ------------------------------
\* Session statechart from spec §5. Edges match ts/src/state.ts.
\* DropCrashReport = TRUE deletes crashed→reported. That mutant must fail I1.
EXTENDS Naturals

CONSTANT DropCrashReport

Budget == 2

Edges ==
  { <<"queued", "launching">>,
    <<"launching", "exploring">>,
    <<"launching", "crashed">>,
    <<"exploring", "exploring">>,
    <<"exploring", "stuck">>,
    <<"exploring", "done">>,
    <<"exploring", "budget_exhausted">>,
    <<"exploring", "crashed">>,
    <<"stuck", "reported">>,
    <<"done", "reported">>,
    <<"budget_exhausted", "reported">> }
  \union (IF DropCrashReport THEN {} ELSE {<<"crashed", "reported">>})

VARIABLES state, steps, preReport, findings, merged, verdict

vars == <<state, steps, preReport, findings, merged, verdict>>

Legal(a, b) == <<a, b>> \in Edges

Init ==
  /\ state = "queued"
  /\ steps = 0
  /\ preReport = "none"
  /\ findings = 0
  /\ merged = 0
  /\ verdict = "pending"

Start ==
  /\ state = "queued"
  /\ state' = "launching"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

Loaded ==
  /\ state = "launching"
  /\ state' = "exploring"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

LaunchFail ==
  /\ state = "launching"
  /\ state' = "crashed"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

DoStep ==
  /\ state = "exploring"
  /\ steps < Budget
  /\ state' = "exploring"
  /\ steps' = steps + 1
  /\ findings' = findings + 1
  /\ UNCHANGED <<preReport, merged, verdict>>

GiveUp ==
  /\ state = "exploring"
  /\ steps >= 1
  /\ state' = "stuck"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

Finish ==
  /\ state = "exploring"
  /\ state' = "done"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

Exhaust ==
  /\ state = "exploring"
  /\ steps >= Budget
  /\ state' = "budget_exhausted"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

ExploreFail ==
  /\ state = "exploring"
  /\ state' = "crashed"
  /\ UNCHANGED <<steps, preReport, findings, merged, verdict>>

Report ==
  /\ state \in {"stuck", "done", "budget_exhausted", "crashed"}
  /\ Legal(state, "reported")
  /\ preReport' = state
  /\ state' = "reported"
  /\ merged' = findings
  /\ verdict' = IF state = "crashed" THEN "inconclusive" ELSE "scored"
  /\ UNCHANGED <<steps, findings>>

\* Keeps reported (and a mutant crash) from looking like a deadlock,
\* so the mutant fails liveness I1 instead of only the deadlock check.
Idle ==
  /\ \/ state = "reported"
     \/ (DropCrashReport /\ state = "crashed")
  /\ UNCHANGED vars

Next ==
  \/ Start \/ Loaded \/ LaunchFail \/ DoStep \/ GiveUp
  \/ Finish \/ Exhaust \/ ExploreFail \/ Report \/ Idle

Spec == Init /\ [][Next]_vars
  /\ WF_vars(Start) /\ WF_vars(Loaded) /\ WF_vars(Report) /\ SF_vars(Finish)

I1 == <> (state = "reported")
I2 == [][ state = "reported" => state' = "reported" ]_vars
I3 == verdict = "scored" => preReport /= "crashed"
I4 == state = "stuck" => steps >= 1
I5 == [][ state' /= state => Legal(state, state') ]_vars
I6 == state = "reported" => merged = findings
Inv == I3 /\ I4 /\ I6

=============================================================================
