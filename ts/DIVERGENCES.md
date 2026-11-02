# v1 / v2 divergences

Parity is against `frl run` (kind `auto`) on the synthetic pages in `examples/`. v2 matches those scores exactly.

| Fixture | v1 | v2 | Delta |
|---|---:|---:|---:|
| `examples/signup.html` | 36 | 36 | 0 |
| `examples/signup-fixed.html` | 100 | 100 | 0 |
| `examples/help.html` | 98 | 98 | 0 |
| `examples/leaderboard-demo.html` | 98 | 98 | 0 |
| `examples/report-demo.html` | 98 | 98 | 0 |

`help.html`, the leaderboard, and the sample report are dashboards under `auto` (no fields), so a missing call to action is minor. `report-demo.html` also has a minor horizontal scroll; both minors sit on one hotspot, so the score is 98. `main()` with its default `kind="form"` scores a dashboard 94. The CLI default is the oracle.

## Intentional, from the spec addendum

These two v1 bugs are not copied. They do not show up on `examples/`.

1. **Closed sections are not controls.** v1 treats elements inside a closed `<details>` and inside a collapsed accordion as visible, so it reports them as nameless, unreachable, and tiny. v2 drops a control when it sits in a closed `details` (the summary stays), in a panel whose trigger is `aria-expanded="false"`, or in an ancestor clipped to a zero-size overflow box. On `ts/fixtures/closed-section.html`, v1 scores **28** and names `hidden-btn`, `DIV`, `buried`, and `Inside accordion`. v2 scores **74** and keeps only `Add item` and the open-details field `shown`.

2. **Tab until focus wraps.** v1 stops after `len(controls) + 5` presses, so a control that sits behind extra tab stops is called unreachable. v2 keeps pressing Tab until focus returns to the first focused element, with a hard cap of 500, and only controls never reached before that wrap are unreachable. On `ts/fixtures/tab-wrap.html` (12 non-control tab stops between Save and Send), v1 scores **40** and marks `Send` unreachable. v2 scores **60**, reaches `Send`, and still marks the clickable `Go` div unreachable. The bake-sale pages wrap inside the old budget, so their scores do not move. Python fix PR #1 uses a cap of 1000. v2 keeps 500, which is enough for that regression (`ts/fixtures/manystops.html` wraps inside the cap and no longer reports `unreachable_by_keyboard`).

3. **A form that re-draws its fields is a finding, not a crash.** v1's `get_attribute` waits out the default timeout and the skimmer crashes. v2 re-queries the page and retries, up to 3 passes, with a 2 second timeout. If a field is still being replaced after that, the skimmer records major `form_redraws_while_typing` and the run stays scored.

4. **A link whose request fails is a dead link.** Connection reset, connection refused, and timeout are major `dead_link` findings. v1 lets the exception crash the link-checker persona, which makes the whole run inconclusive.

## Other differences

- **Persona id.** The spec's fifth persona is `curious` (label "Link-clicker"). v1 calls it `linkchecker`. Scores ignore the id. A dead-link hotspot lists `curious` instead of `linkchecker`.
- **Verdict shape.** v2 uses the spec union `{kind: "scored", score}` | `{kind: "inconclusive", crashed}`. A scored value has no `crashed` field, and `verdictFor` will not build one when a session's pre-report state is `crashed`. `unreachable` and `needs_backend` (§13, §15) are extra unscored variants. v1 uses a string verdict and `score: null`.
- **Finding shape.** The field is `control` (spec), not v1's `target`. Evidence is `{shot, box?}` and each finding has a `step`.
- **Step log.** v2 records an `exploring → exploring` edge per step, then `stuck`, so invariant I4 is in the log. v1 keeps the step count in a local and jumps `exploring → stuck`. The bake-sale end states match: skimmer `stuck`, the other four `done`.
- **Hotspot ids match** when the control key matches. `Sign up` is `F0b8149` in both.
- **Kind order.** The stored list stays in first-seen order, same as v1. The HTML report and the terminal lines show the highest-severity kind first.
- **Unlabeled fields.** Inputs and selects only, matching v1. A textarea is not flagged.
- **Non-network URLs.** `data:`, `blob:`, and `about:` are not remote hosts, so the route hook allows them. Every other host is aborted.
- **TLA+ bound.** Exploring self-loops stop at `MaxSteps` so TLC's state space is finite. That bound is the engine's step budget. A final `Done` stutter keeps `reported` from looking like a deadlock to TLC.
