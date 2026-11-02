# Model

`spec/FirstRunLab.tla` is the session and run statechart. `tools/gen-statechart.mjs` writes `ts/src/statechart.generated.ts` from the `@table` blocks, and the engine's `TRANSITION_TABLE` is locked to that table by `ts/test/fixes.test.ts`.

TLC (`tools/check-tlc.sh`) checks invariants I1–I6 on the correct model (`Mutant = "none"`) and must reject three mutants: `drop_crashed_report` (liveness I1), `score_while_crashed` (I3), and `merge_drops` (I6).

Scoring differences from Python v1 are in `ts/DIVERGENCES.md`.
