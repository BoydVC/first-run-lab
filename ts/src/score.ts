import type { Severity } from "./types.ts";

/** 100 − min(60, 20·blockers) − min(30, 6·majors) − min(10, 2·minors), floored at 0. */
export function score(hotspots: { severity: Severity }[]): number {
  let blockers = 0;
  let majors = 0;
  let minors = 0;
  for (const h of hotspots) {
    if (h.severity === "blocker") blockers++;
    else if (h.severity === "major") majors++;
    else minors++;
  }
  return Math.max(0, 100 - Math.min(60, 20 * blockers) - Math.min(30, 6 * majors) - Math.min(10, 2 * minors));
}
