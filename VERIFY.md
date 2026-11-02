# First-Run Lab v2 verification

Python v1 on `main` (`bb19fc6`, plus the CI commit on `origin/main`) is the scoring reference. `SPEC.md` is not in the repository or on any seat branch. AT1–AT15 below are the checks that all three acceptance suites and their draft PR bodies agree on. Each seat was typechecked, its own suite was run, TLC was run on its model, its demo GIF was OCR'd, and the same pages were scored through its CLI.

Nothing here was merged. Nothing was deployed. Nothing was posted.

## Scorecard

| | types-first (#2) | model-first (#3) | experience-first (#4) | winner |
|---|---|---|---|---|
| `tsc --strict` | pass | pass | pass | pass |
| Own tests | 36/36 in 59s | 27/27 in 32s | 30/30, file 65s, `npm test` wall 68s | 43/43 in 67s |
| AT1–AT14 via CLI | pass | pass, with the notes below | pass | pass (suite + CLI parity) |
| AT15 fixture suite under 60s | pass (acceptance file 54.2s) | pass (suite 32.4s) | pass inside the file; wall clock includes `tsc` and is 68s | pass (acceptance file still under 60s; extra fix tests sit in another file) |
| TLC | 66 states, 0 errors; dropping `crashed → reported` fails | 17,554 states, 6,518 distinct, depth 18, 0 errors; three mutants killed | 33 states, 0 errors; mutant fails I1 | same model as model-first: 0 errors, three mutants killed |
| `examples/` vs v1, kind `auto` | 36, 100, 98, 98, 98 (delta 0) | same | same | same |
| Closed `<details>` / collapsed accordion | not visible | not visible | not visible | not visible |
| Tab until focus wraps | yes, cap 500 | yes, cap 500 | yes, cap 500 | yes, cap 500 |
| Re-drawn fields | no crash, no finding | skimmer crashes (~31s) | no crash, no finding | major `form_redraws_while_typing`, run stays scored |
| Reset / refused / timeout link | link-checker crashes | link-checker crashes; timeout still running at 20s | reset and timeout crash the link-checker; a refused other port is skipped | major `dead_link`, run stays scored |
| Fuzz, 50 synthetic pages | 0 crashes, mean 3.5s, 12 pages outside ±2 of v1 | 0 crashes, mean 3.5s, 42 pages outside ±2 | 0 crashes, mean 2.9s, same 12 pages as types-first | 0 crashes, mean 2.6s, the same 12 pages |
| GIF privacy OCR | clean | clean | clean | clean |

v1 scores on `examples/` with kind `auto`: signup **36**, signup-fixed **100**, help **98**, leaderboard-demo **98**, report-demo **98**.

## Acceptance tests

| ID | What was required | types | model | experience |
|---|---|---|---|---|
| AT1 | signup scored, score ≤ 50, ≥ 6 hotspots | 36, 6 hotspots | same | same |
| AT2 | top hotspot Sign up, blocker, ≥ 3 personas, includes silent_failure, unreachable_by_keyboard, fake_button | 4 of 5 | same | same |
| AT3 | one hotspot per control; ☰ is tiny_tap_target + unnamed_control | pass | pass | pass |
| AT4 | fixed page 100, every session done, every bad hotspot id resolved | pass | pass | pass |
| AT5 | skimmer ends `stuck` with slow_or_no_confirmation | pass | pass | pass |
| AT6 | injected `querySelectorAll` throw is inconclusive and has no score | inconclusive, exit 2 | inconclusive, CLI exit 0 | inconclusive, exit 2 |
| AT7 | new alert text is feedback; unchanged text is silent_failure | suite pass | suite pass and the independent probe pass | suite pass |
| AT8 | gate 0 / 1 / 2 | 0, 1, 2 | 0, 1, 2 | 0, 1, 2 |
| AT9 | `https://example.com` exits 64 before launch; cross-origin image aborted | 95ms, exit 64 | 314ms, exit 64 | 475ms, exit 64 |
| AT10 | `a.b@example.com` exits 3 and writes no `run.json` | pass | pass | pass |
| AT11 | sweep orders a scored app ahead of an inconclusive one | suite pass | suite pass | suite pass |
| AT12 | `tablet-kid.json` runs from its checks | tiny_tap_target, not crashed | same | same |
| AT13 | TLC I1–I6 clean; dropping `crashed → reported` fails | pass | pass | pass |
| AT14 | two signup runs share score and hotspot ids | 36 and the same ids | same | same |
| AT15 | fixture suite under 60s | 54.2s | 32.4s | assertion passed; `npm test` wall 68s |

The independent sweep call failed on all three seats with `EISDIR` because the harness passed a directory as `--out` and the CLIs open that path as a file. That is a harness mistake. AT11 is taken from each seat's own suite, which passes.

AT6's first automated check also rejected a correct inconclusive verdict when the summary JSON contained `"score": null`. The verdicts above are from reading the runs. Model-first's `run` command returns exit 0 for an inconclusive run. Gate still returns 2. The winner, from the types-first CLI, returns 2.

## Seat notes

**types-first** is the strictest TypeScript: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, no explicit `any`. The session table is the source, and a small generated `Session.tla` (66 states) checks I1–I6. The vitest suite covers AT1–AT15 plus the v1 fixture rules (canvas, toast, focus, covered CTA, API classification). It does not retry a re-drawn field, and a thrown `request.get` crashes the curious persona.

**model-first** has the model worth keeping. `spec/FirstRunLab.tla` is 17,554 states with weak fairness, and TLC kills `drop_crashed_report`, `score_while_crashed`, and `merge_drops`. The first suite run here was 25/27. One failure was `ip` missing (`unshare` could not bring loopback up). The other was this verifier truncating `spec/tlc/none.out` while the test read it. After `iproute2` was installed and TLC finished, the suite was 27/27. The engine is the one that still crashes: the skimmer's `getAttribute` waits out a re-drawn field (~31s, inconclusive), and the link-checker crashes on reset, refused, and timeout. On the 50 fuzz pages it also scores 42 of them more than 2 points away from v1, usually 6 points lower on pages v1 scores 100.

**experience-first** has the report, the terminal sentence, and the dashboard. The report is a score dial, a plain-English line, and one fix hint per kind, with kinds shown highest-severity first. The dashboard has Runs, Leaderboard, and Statechart, 44px hit targets, and no horizontal overflow at 375px. Its TLA+ model is the smallest (33 states) and has a single mutant. It swallows a re-drawn field without a finding. Reset and timeout crash the link-checker. A link to another port on `127.0.0.1` is treated as off-site, so it is skipped rather than recorded as a dead link. `npm test` wall time is 68s because it typechecks first; the AT15 assertion inside the file passed.

## Privacy

Tesseract OCR on every frame of each `screenshots/demo-ts.gif`, plus a regex for emails, phone numbers, SSNs, and token shapes.

| GIF | Size | What the frames say |
|---|---|---|
| types-first | 98 KB, 16 logical frames | Pinecrest Bake Sale, score 36 then 100. No email, phone, SSN, or token. |
| model-first | 113 KB | Same bake-sale page. Clean. |
| experience-first | 217 KB, 14 frames | Bake sale plus the report sentence "Clicked Sign up and nothing happened". Clean. |
| winner | 98 KB, 16 frames | Pinecrest Bake Sale, "Sign up tripped up 4 of 5 personas", 36 / 100, then 100 / 100. Clean. |

OCR misreads "Saturday 10am" and "Allergy info" (for example "Saturday Loam", "Help Alera"). Those strings are not in the page source. The page is the synthetic bake sale. No personal names, emails, or tokens.

## Break attempts

Same pages for v1 and all three seats.

| Probe | v1 (`main`, unfixed) | types-first | model-first | experience-first |
|---|---|---|---|---|
| `querySelectorAll` throws | process error | inconclusive | inconclusive | inconclusive |
| `https://example.com` | exits 1 ("refusing") | exit 64 in 95ms | exit 64 in 314ms | exit 64 in 475ms |
| Button labeled `a.b@example.com` | privacy exit | exit 3, no `run.json` | exit 3, no `run.json` | exit 3, no `run.json` |
| Form re-draws inputs on `input` | skimmer crashes, inconclusive, 33s | scored 100, no finding, 8s | skimmer crashes, 31s | scored 100, no finding, 7s |
| Connection reset on a same-origin link | (covered by the winner test; v1's uncaught `request.get` crashes the persona) | link-checker does not finish a scored run | curious crashes | curious crashes |
| Refused `127.0.0.1:1` | skipped as off-site (netloc includes the port), score 98 | curious crashes | curious crashes | curious finishes, no `dead_link` |
| Request that never answers | — | curious crashes at ~7s | killed at the 20s harness cap | curious crashes at ~10s |
| Closed `<details>` links (`collapsed.html`) | 74, with unnamed_control and unreachable_by_keyboard | 94, only tiny_tap_target on Start demo | 94, those links absent | 94, those links absent |
| 40 extra tab stops (`manystops.html`) | 34, unreachable_by_keyboard | 100, nothing unreachable | 100 | 100 |

Fuzz pages are deterministic from seed `20261102`: synthetic labels only (Save, Start, Notes, pad N). No emails and no personal names. Zero crashes on every seat. The 12 pages where types-first and experience-first differ from v1 by more than 2 are the pages that include a closed `<details>` or extra tab stops, which is the intended divergence. Model-first disagrees on 42 of 50, including clean pages. The winner, scored in-process on the same 50 pages, also had 0 crashes (mean 2.6s) and the same 12 drifts: 40→54, 60→80, 80→100.

## Base

**types-first.** It is the only engine that is strict under `noUncheckedIndexedAccess`, passes AT1–AT15 in one suite, matches v1 exactly on `examples/`, and matches v1 on the fuzz pages that do not hit the two intentional divergences. Model-first's scorer drifts on clean pages and crashes on the two bugs the winner has to fix. Experience-first's scorer matches types-first, and its report is the piece to graft rather than the base.

## What the winner takes from each seat

- **types-first (base):** `ts/` engine, vitest suite, branded ids, exhaustive switches, privacy scan, demo GIF builder.
- **model-first:** `spec/FirstRunLab.tla`, the three mutant configs, `tools/check-tlc.sh`, and `tools/gen-statechart.mjs`. `ts/src/statechart.generated.ts` is generated from the `@table` blocks. `ts/test/fixes.test.ts` fails if `TRANSITION_TABLE` drifts from that table. TLC on the winner: correct model OK, `drop_crashed_report` exit 13, `score_while_crashed` exit 12, `merge_drops` exit 12.
- **experience-first:** `copy.ts` (headline, dial sentence, one fix line per kind, highest-severity kind first on screen), `report.ts` (score dial, hotspot cards, before/after slider, leaderboard), and `serve.ts` (Runs / Leaderboard / Statechart, 44px targets). The CLI prints that terminal block and writes that HTML. A phone-width dashboard test tabs through the three sections with no horizontal overflow.
- **PR #1, all four fixes:** closed `<details>` and collapsed accordions are not visible (`checkVisibility` plus the details/accordion predicate); Tab continues until focus wraps (cap 500, which covers the manystops regression; PR #1's Python uses 1000); a field that is still being re-drawn after 3 passes is major `form_redraws_while_typing` instead of a crash; connection reset, refused, and timeout are major `dead_link`.

Python v1 in `src/frl` is unchanged.

## Bugs this winner does not fix

- Hotspot `kinds` in `run.json` stay in first-seen order. The report and the terminal show the highest-severity kind first. A reader of the JSON does not get that order.
- Outside `examples/`, scores move by more than 2 when a page has controls inside a closed section or more tab stops than v1's `control count + 5`. That is the required divergence. It showed up on 12 of the 50 fuzz pages for the types-first scorer.
- The fifth persona id is `curious`. v1 says `linkchecker`. Scores do not use the id.
- The tab cap is 500, not PR #1's 1000. `manystops.html` wraps inside 500.
- Model-first returns exit 0 from `run` when the verdict is inconclusive. The winner returns 2, matching types-first and experience-first. Gate is 2 on every seat, including model-first.
- v1 on `main` still has the four bugs. They are fixed only in this TypeScript engine and in draft PR #1. This branch does not patch `src/frl`.
