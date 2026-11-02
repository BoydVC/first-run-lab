import type { Hotspot, Run } from "./types.ts";

export interface Diff {
  resolved: Hotspot[];
  added: Hotspot[];
  scoreA: number | null;
  scoreB: number | null;
}

export function diffRuns(a: Run, b: Run): Diff {
  const aIds = new Set(a.hotspots.map((h) => h.id));
  const bIds = new Set(b.hotspots.map((h) => h.id));
  return {
    resolved: a.hotspots.filter((h) => !bIds.has(h.id)),
    added: b.hotspots.filter((h) => !aIds.has(h.id)),
    scoreA: a.verdict.kind === "scored" ? a.verdict.score : null,
    scoreB: b.verdict.kind === "scored" ? b.verdict.score : null,
  };
}
