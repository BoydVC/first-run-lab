------------------------------ MODULE FirstRunLab ------------------------------
(* First-Run Lab v2 — model-first session statechart, run verdict, and merge.
   Source of truth for ts/src/statechart.generated.ts (parsed from the tables
   below). TLC instance: N = 3 sessions, Budget = 1, Mutant = "none".

   Session edges (why labels are the only legal steps):
     queued --start--> launching --loaded--> exploring ⟲ step
     launching --error--> crashed
     exploring --gave_up--> stuck          (guard: steps >= 1)
     exploring --checks_complete--> done
     exploring --budget--> budget_exhausted (guard: steps >= Budget)
     exploring --error--> crashed
     {stuck, done, budget_exhausted, crashed} --report--> reported  (only sink)

   Run phase: idle --start--> running --all_clear--> scored
                              running --any_crashed--> inconclusive
   Inconclusive iff any session's pre-report state is crashed.

   Invariants:
     I1  every session reaches reported (liveness, weak fairness)
     I2  reported is absorbing
     I3  verdict = scored => no session's pre-report state is crashed
     I4  stuck happens only after >= 1 step
     I5  every step taken is in the base transition table
     I6  merging by control loses no finding (bag size is preserved)

   Mutants (CONSTANT Mutant), each of which TLC must reject:
     "drop_crashed_report"  remove crashed --report--> reported  (fails I1)
     "score_while_crashed"  score a run that has a crashed session (fails I3)
     "merge_drops"          drop session N's finding when merging (fails I6)
*)

EXTENDS Naturals, FiniteSets

CONSTANTS N, Budget, Mutant

ASSUME N \in Nat /\ N >= 1
ASSUME Budget \in Nat /\ Budget >= 1
ASSUME Mutant \in {"none", "drop_crashed_report", "score_while_crashed", "merge_drops"}

Sessions == 1..N
Controls == {"c1", "c2"}

SessionState == {
  "queued", "launching", "exploring", "stuck", "done",
  "budget_exhausted", "crashed", "reported"
  }

\* @table Session
BaseTable == {
  [from |-> "queued",            why |-> "start",            to |-> "launching"],
  [from |-> "launching",         why |-> "loaded",           to |-> "exploring"],
  [from |-> "launching",         why |-> "error",            to |-> "crashed"],
  [from |-> "exploring",         why |-> "step",             to |-> "exploring"],
  [from |-> "exploring",         why |-> "gave_up",          to |-> "stuck"],
  [from |-> "exploring",         why |-> "checks_complete",  to |-> "done"],
  [from |-> "exploring",         why |-> "budget",           to |-> "budget_exhausted"],
  [from |-> "exploring",         why |-> "error",            to |-> "crashed"],
  [from |-> "stuck",             why |-> "report",           to |-> "reported"],
  [from |-> "done",              why |-> "report",           to |-> "reported"],
  [from |-> "budget_exhausted",  why |-> "report",           to |-> "reported"],
  [from |-> "crashed",           why |-> "report",           to |-> "reported"]
  }

\* @table Run
RunTable == {
  [from |-> "idle",     why |-> "start",        to |-> "running"],
  [from |-> "running",  why |-> "all_clear",    to |-> "scored"],
  [from |-> "running",  why |-> "any_crashed",  to |-> "inconclusive"]
  }

TransitionTable ==
  IF Mutant = "drop_crashed_report"
  THEN {t \in BaseTable : ~(t.from = "crashed" /\ t.to = "reported")}
  ELSE BaseTable

\* Deterministic findings so the state space stays finite and the merge
\* mutant is forced to drop a real finding: sessions 1 and 3 share c1,
\* session 2 has c2. Grouping is by control; the bag still has 3 findings.
DefaultFinding(s) == IF s = 2 THEN "c2" ELSE "c1"

VARIABLES state, steps, pre, finding, phase, seen,
          lastFrom, lastTo, lastWhy, realCount, mergedCount, bit

vars == <<state, steps, pre, finding, phase, seen,
          lastFrom, lastTo, lastWhy, realCount, mergedCount, bit>>

Whys == {"", "start", "loaded", "step", "gave_up", "checks_complete",
         "budget", "error", "report"}

TypeOK ==
  /\ state \in [Sessions -> SessionState]
  /\ steps \in [Sessions -> 0..Budget]
  /\ pre \in [Sessions -> SessionState \cup {"none"}]
  /\ finding \in [Sessions -> {"none", "c1", "c2"}]
  /\ phase \in {"idle", "running", "scored", "inconclusive"}
  /\ seen \in [Sessions -> BOOLEAN]
  /\ lastFrom \in [Sessions -> SessionState \cup {"none"}]
  /\ lastTo \in [Sessions -> SessionState \cup {"none"}]
  /\ lastWhy \in [Sessions -> Whys]
  /\ realCount \in 0..N
  /\ mergedCount \in 0..N
  /\ bit \in {0, 1}

Init ==
  /\ state = [s \in Sessions |-> "queued"]
  /\ steps = [s \in Sessions |-> 0]
  /\ pre = [s \in Sessions |-> "none"]
  /\ finding = [s \in Sessions |-> "none"]
  /\ phase = "idle"
  /\ seen = [s \in Sessions |-> FALSE]
  /\ lastFrom = [s \in Sessions |-> "none"]
  /\ lastTo = [s \in Sessions |-> "none"]
  /\ lastWhy = [s \in Sessions |-> ""]
  /\ realCount = 0
  /\ mergedCount = 0
  /\ bit = 0

\* One legal step for session s. setFind records DefaultFinding(s).
Touch(s, why, dest, dStep, setFind, ph) ==
  /\ \E t \in TransitionTable : t.from = state[s] /\ t.why = why /\ t.to = dest
  /\ state' = [state EXCEPT ![s] = dest]
  /\ steps' = [steps EXCEPT ![s] = steps[s] + dStep]
  /\ pre' = [pre EXCEPT ![s] = IF dest = "reported" THEN state[s] ELSE pre[s]]
  /\ finding' = [finding EXCEPT ![s] = IF setFind THEN DefaultFinding(s) ELSE finding[s]]
  /\ phase' = ph
  /\ seen' = [seen EXCEPT ![s] = seen[s] \/ dest = "reported"]
  /\ lastFrom' = [lastFrom EXCEPT ![s] = state[s]]
  /\ lastTo' = [lastTo EXCEPT ![s] = dest]
  /\ lastWhy' = [lastWhy EXCEPT ![s] = why]
  /\ UNCHANGED <<realCount, mergedCount, bit>>

Start(s) ==
  /\ state[s] = "queued"
  /\ Touch(s, "start", "launching", 0, FALSE,
           IF phase = "idle" THEN "running" ELSE phase)

Load(s) ==
  /\ state[s] = "launching"
  /\ Touch(s, "loaded", "exploring", 0, FALSE, phase)

Step(s) ==
  /\ state[s] = "exploring"
  /\ steps[s] < Budget
  /\ Touch(s, "step", "exploring", 1, FALSE, phase)

GiveUp(s) ==
  /\ state[s] = "exploring"
  /\ steps[s] >= 1
  /\ Touch(s, "gave_up", "stuck", 0, TRUE, phase)

Complete(s) ==
  /\ state[s] = "exploring"
  /\ Touch(s, "checks_complete", "done", 0, TRUE, phase)

BudgetExit(s) ==
  /\ state[s] = "exploring"
  /\ steps[s] >= Budget
  /\ Touch(s, "budget", "budget_exhausted", 0, TRUE, phase)

Error(s) ==
  \/ /\ state[s] = "launching"
     /\ Touch(s, "error", "crashed", 0, FALSE, phase)
  \/ /\ state[s] = "exploring"
     /\ Touch(s, "error", "crashed", 0, TRUE, phase)

Report(s) ==
  /\ Touch(s, "report", "reported", 0, FALSE, phase)

\* Enabled only for the drop-crashed mutant, so a crashed session can stutter
\* without a deadlock while still never reaching reported (I1).
WaitForever(s) ==
  /\ Mutant = "drop_crashed_report"
  /\ state[s] = "crashed"
  /\ bit' = 1 - bit
  /\ UNCHANGED <<state, steps, pre, finding, phase, seen,
                 lastFrom, lastTo, lastWhy, realCount, mergedCount>>

\* Merge findings by control. The bag size is the sum of per-control counts.
\* merge_drops omits session N, so the bag shrinks and I6 fails.
CountOf(c) ==
  Cardinality({s \in Sessions :
                finding[s] = c /\ (Mutant # "merge_drops" \/ s # N)})

Derive ==
  /\ phase = "running"
  /\ \A s \in Sessions : state[s] = "reported"
  /\ LET crashed == \E s \in Sessions : pre[s] = "crashed"
         nxt == IF Mutant = "score_while_crashed" THEN "scored"
                ELSE IF crashed THEN "inconclusive" ELSE "scored"
         real == Cardinality({s \in Sessions : finding[s] # "none"})
         merged == CountOf("c1") + CountOf("c2")
     IN /\ phase' = nxt
        /\ realCount' = real
        /\ mergedCount' = merged
        /\ UNCHANGED <<state, steps, pre, finding, seen, lastFrom, lastTo, lastWhy, bit>>

\* Terminal self-loop so a finished run is not a deadlock.
Tick ==
  /\ phase \in {"scored", "inconclusive"}
  /\ bit' = 1 - bit
  /\ UNCHANGED <<state, steps, pre, finding, phase, seen,
                 lastFrom, lastTo, lastWhy, realCount, mergedCount>>

Next ==
  \/ \E s \in Sessions : Start(s) \/ Load(s) \/ Step(s) \/ GiveUp(s) \/ Complete(s)
                        \/ BudgetExit(s) \/ Error(s) \/ Report(s) \/ WaitForever(s)
  \/ Derive
  \/ Tick

\* Weak fairness: each session keeps taking whatever step is enabled, and the
\* run eventually derives a verdict. Bounded steps keep the exploring loop from
\* satisfying fairness by itself.
Progress(s) ==
  Start(s) \/ Load(s) \/ Step(s) \/ GiveUp(s) \/ Complete(s)
  \/ BudgetExit(s) \/ Error(s) \/ Report(s)

Fairness ==
  /\ \A s \in Sessions : WF_vars(Progress(s))
  /\ WF_vars(Derive)

Spec == Init /\ [][Next]_vars /\ Fairness

\* I1 liveness.
I1 == <>(\A s \in Sessions : state[s] = "reported")

EventuallyVerdict == <>(phase \in {"scored", "inconclusive"})

\* I2 reported is absorbing (seen is sticky).
I2 == \A s \in Sessions : seen[s] => state[s] = "reported"

\* I3 a scored verdict never hides a crash.
I3 == phase = "scored" => \A s \in Sessions : pre[s] # "crashed"

\* I4 stuck only after at least one step.
I4 == \A s \in Sessions : (state[s] = "stuck" \/ pre[s] = "stuck") => steps[s] >= 1

\* I5 no step outside the base table (the mutant may only delete an edge).
I5 == \A s \in Sessions :
  lastTo[s] = "none" \/
  \E t \in BaseTable : t.from = lastFrom[s] /\ t.to = lastTo[s] /\ t.why = lastWhy[s]

\* I6 hotspot bag size equals the number of session findings.
I6 == phase \in {"scored", "inconclusive"} => mergedCount = realCount

THEOREM Spec => [](TypeOK /\ I2 /\ I3 /\ I4 /\ I5 /\ I6)
THEOREM Spec => (I1 /\ EventuallyVerdict)
=============================================================================
