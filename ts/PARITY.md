# v1 ↔ v2 parity

v2 is the TypeScript engine in `ts/`. v1 is the Python engine in `src/frl`. Scores below are on the synthetic pages in `examples/`. Hotspot ids are `F` + the first 6 hex chars of sha1(control), so the same control keeps the same id.

| Fixture | v1 score | v2 score | Delta | Hotspot ids |
|---|---:|---:|---:|---|
| `examples/signup.html` | 36 | 36 | 0 | F0b8149 Sign up, Fda86fe ☰, F767013 page, Fab4229 Your name, F3a7d97 item, F38aed5 Allergy info |
| `examples/signup-fixed.html` | 100 | 100 | 0 | none |

v1's checked-in sample report (`examples/report-demo.html`) lists those same six ids at 36. v2 reproduces them. The fixed page is 100 with every session `done`.

Dashboard dogfood (`frl serve`, auto kind): **98 / 100**. The only finding is a minor `no_clear_cta` because the page is a read-only dashboard. That is above the 90 bar.

## Intentional divergences

These two are v1 bugs. v2 does not copy them. On the example pages they do not move the score. On the fixtures named here, they do.

1. **Closed or collapsed sections are not visible.** v1's visibility check (layout box, not `visibility:hidden`, not inside `[aria-hidden]`, `[inert]`, or a closed `dialog`) still counts a control inside a closed `<details>` when author CSS gives that control a box, and a control inside a collapsed accordion (`aria-expanded=false` and/or a 0-height `overflow:hidden` panel). Those controls were flagged `unnamed_control`. v2 treats them as not visible, so they are not nameless controls and they are not tap targets. Test: `closed details and a collapsed accordion are not nameless controls`. The fixture asserts the v1 predicate would still see both hidden buttons.

2. **Keyboard Tab runs until focus wraps, with a hard cap of 500.** v1 stops after `visibleControls + 5` tabs (the earlier bug was a flat 12). Extra tab stops that are not controls — a row of `tabindex=0` divs, for example — use up that budget, and a real button after them is reported `unreachable_by_keyboard` (a blocker, up to 20 points). v2 keeps pressing Tab until focus returns to the first focusable element, and stops at 500 if it never wraps. Only controls never reached before the wrap are unreachable. On `examples/signup.html` the tab order wraps inside v1's budget, so both engines flag only the fake Sign up div. Test: `keyboard tabs until focus wraps, past the old control-count-plus-five cap`.

## Other differences that do not change example scores

- The fifth persona id is `curious` (spec §3). v1 calls the same check `linkchecker`. The Allergy info hotspot id is still F38aed5.
- Evidence images are cropped to the control with a highlight ring. v1 stores a full-page screenshot.
- `run.json` follows the spec schema: `verdict` is an object, findings use `control`, transitions use `atMs`. v1 writes a flat `score`, `target`, and `t`.
- A non-local URL exits **64** before launch (spec AT9). v1 exits 1.
- The report lists each hotspot's kinds highest-severity first (spec O9). The stored kind list stays in discovery order, which matches v1.
- `stuck` is entered only after the step counter has incremented, so invariant I4 holds. v1 increments the counter after the unclickable transition.
- v2 reuses one browser per run. v1 launches one browser per persona.
- v2 scans the fetched HTML, then `run.json` and `report.html`, and refuses (exit 3, nothing kept) on email, phone, or SSN hits. GIF frames are OCR-scanned the same way.
- `personas/tablet-kid.json` is shipped but not in the default five, so example scores stay comparable. `--personas tablet-kid` runs it with no engine change.
- `unclickable_cta`, `broken_api`, `unreachable`, and `needs_backend` follow spec §13–15. They are outside the original §4 union.
