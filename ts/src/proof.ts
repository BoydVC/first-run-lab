/**
 * Compile-time witnesses. `tsc --strict` fails if a scored verdict can
 * carry crashed personas, or if an illegal statechart edge type-checks.
 */
import { edge, type LegalTarget } from "./statechart.js";
import {
  assertNever,
  personaId,
  type ScoredCrashUnrepresentable,
  type ScoredVerdict,
  type Verdict,
} from "./types.js";

export const scoredHasNoCrashField: ScoredCrashUnrepresentable = true;

type QueuedOnlyLaunch = LegalTarget<"queued"> extends "launching" ? true : never;
export const queuedOnlyLaunches: QueuedOnlyLaunch = true;

type ReportedNotFromQueued = "reported" extends LegalTarget<"queued"> ? never : true;
export const queuedExcludesReported: ReportedNotFromQueued = true;

type ExploringAllowsStuck = "stuck" extends LegalTarget<"exploring"> ? true : never;
export const exploringCanStick: ExploringAllowsStuck = true;

edge("queued", "launching", "start", 0);
edge("launching", "exploring", "loaded", 1);
edge("launching", "crashed", "error", 1);
edge("exploring", "exploring", "step", 2);
edge("exploring", "done", "checks_complete", 3);
edge("crashed", "reported", "report", 4);

// @ts-expect-error reported is not a legal edge from queued
edge("queued", "reported", "no", 0);

// @ts-expect-error exploring cannot jump straight to reported
edge("exploring", "reported", "no", 0);

// @ts-expect-error a scored verdict cannot list crashed personas
const rejected: ScoredVerdict = { kind: "scored", score: 100, crashed: [personaId("skimmer")] };

void rejected;

export function acceptsOnlyVerdict(v: Verdict): number | string {
  switch (v.kind) {
    case "scored":
      return v.score;
    case "inconclusive":
      return v.crashed.length;
    case "unreachable":
      return v.detail;
    case "needs_backend":
      return v.detail;
    default:
      return assertNever(v);
  }
}
