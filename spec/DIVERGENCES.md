# v1 vs v2 divergences

v2 is the TypeScript engine in `ts/`. v1 (`src/frl`) is unchanged and remains the oracle for the synthetic pages in `examples/`.

## Examples parity

`kind=auto`, five personas, budget 12. Hotspot ids are `F` + sha1(control)[:6]. Every example page scores the same number.

| Page | v1 | v2 | Delta | Hotspot ids |
|---|---:|---:|---:|---|
| examples/signup.html | 36 | 36 | 0 | same six ids, same kinds |
| examples/signup-fixed.html | 100 | 100 | 0 | both empty |
| examples/help.html | 98 | 98 | 0 | `F767013` minor `no_clear_cta` |
| examples/leaderboard-demo.html | 98 | 98 | 0 | `F767013` minor `no_clear_cta` |
| examples/report-demo.html | 98 | 98 | 0 | `F767013` minor `no_clear_cta` + `horizontal_scroll` |

Signup hotspots (both engines): Sign up blocker, ☰ blocker, page major, Your name major, item major, Allergy info major.

## Intentional divergences (v1 bugs, not copied)

| Fixture | v1 | v2 | Why |
|---|---:|---:|---|
| ts/fixtures/closed-section.html | 38 | 78 | v1 treats controls inside a closed `<details>` (even when CSS gives them a box) and inside an `aria-expanded=false` accordion panel as visible, so it reports `hidden-details` and `hidden-acc` as nameless. v2 does not count them. The visible empty button `seen-icon` is still unnamed. |
| ts/fixtures/long-tab.html | 40 | 60 | v1 stops Tab at `len(controls)+5`, so `Save` (past 30 extra tab stops) is a false `unreachable_by_keyboard`. v2 tabs until focus wraps, hard cap 500, and only `Ghost` (a clickable div with no tabindex) is unreachable. |

## Other spec notes

- The curious persona's id is `curious` (spec). v1 calls the same check `linkchecker`. Scores do not use the id.
- Session log `why` is the formal edge label (`start`, `loaded`, `step`, `gave_up`, `checks_complete`, `budget`, `error`, `report`). v1 stores a free-text reason. Every test log is replayed against `ts/src/statechart.generated.ts`.
- A non-local URL exits 64 before Chromium launches. v1 exits 1.
- Verdicts also include `unreachable` and `needs_backend` from spec §13–§15. They carry no score. `frl gate` exits 2 for any non-scored verdict.
- Finding kinds inside a hotspot are ordered by severity (spec O9). v1 keeps first-seen order. The sets match on `examples/`.
- Anchors are not tap-target findings. WCAG 2.5.8 exempts inline links, and v1 skips `<a>`. Buttons and click handlers under 44px are `small_tap_target`; anything under 24px (except anchors) is `tiny_tap_target`.
- Focus moving onto a field counts as feedback. Focus leaving a field does not. That keeps a second click, after the form was filled, from looking like confirmation.
- `broken_api` findings are attached after personas report, matching v1, when some `/api` calls succeed and some fail.
