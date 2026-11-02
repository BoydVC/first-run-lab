import { createHash } from "node:crypto";
import {
  SEVERITY_RANK,
  assertNever,
  inconclusive,
  scored,
  type Hotspot,
  type HotspotId,
  type PersonaId,
  type Run,
  type Session,
  type Verdict,
} from "./types.js";
import { preReport } from "./statechart.js";

function hotspotId(control: string): HotspotId {
  const hex = createHash("sha1").update(control).digest("hex").slice(0, 6);
  return `F${hex}`;
}

export function mergeFindings(sessions: readonly Session[]): Hotspot[] {
  const order: string[] = [];
  const groups = new Map<string, Hotspot>();
  for (const session of sessions) {
    for (const finding of session.findings) {
      const key = finding.control;
      let hotspot = groups.get(key);
      if (!hotspot) {
        hotspot = {
          id: hotspotId(key),
          control: finding.control,
          severity: finding.severity,
          kinds: [],
          personas: [],
          details: [],
          evidence: finding.evidence,
        };
        groups.set(key, hotspot);
        order.push(key);
      }
      if (!hotspot.kinds.includes(finding.kind)) hotspot.kinds.push(finding.kind);
      if (!hotspot.personas.includes(finding.persona)) hotspot.personas.push(finding.persona);
      hotspot.details.push(finding.detail);
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[hotspot.severity]) {
        hotspot.severity = finding.severity;
        hotspot.evidence = finding.evidence;
      }
    }
  }
  const hotspots = order.map((key) => groups.get(key)).filter((item): item is Hotspot => item !== undefined);
  hotspots.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.personas.length - a.personas.length;
  });
  return hotspots;
}

/** 100 − min(60, 20·blockers) − min(30, 6·majors) − min(10, 2·minors). */
export function scoreOf(hotspots: readonly Hotspot[]): number {
  let blockers = 0;
  let majors = 0;
  let minors = 0;
  for (const hotspot of hotspots) {
    if (hotspot.severity === "blocker") blockers += 1;
    else if (hotspot.severity === "major") majors += 1;
    else minors += 1;
  }
  return Math.max(0, 100 - Math.min(60, 20 * blockers) - Math.min(30, 6 * majors) - Math.min(10, 2 * minors));
}

export function findingCount(sessions: readonly Session[]): number {
  return sessions.reduce((sum, session) => sum + session.findings.length, 0);
}

/** I6: merging groups findings, it does not drop them. */
export function hotspotDetailCount(hotspots: readonly Hotspot[]): number {
  return hotspots.reduce((sum, hotspot) => sum + hotspot.details.length, 0);
}

/**
 * Build the only verdict a finished session list is allowed to have.
 * A crashed pre-report state cannot come back as `scored`.
 */
export function verdictFor(sessions: readonly Session[], hotspots: readonly Hotspot[]): Verdict {
  const crashed: PersonaId[] = [];
  for (const session of sessions) {
    if (preReport(session) === "crashed") crashed.push(session.persona);
  }
  if (crashed.length > 0) return inconclusive(crashed);
  return scored(scoreOf(hotspots));
}

export interface RunDiff {
  resolved: Hotspot[];
  added: Hotspot[];
  persisting: { before: Hotspot; after: Hotspot }[];
}

export function diffRuns(before: Run, after: Run): RunDiff {
  const afterById = new Map(after.hotspots.map((hotspot) => [hotspot.id, hotspot]));
  const beforeIds = new Set(before.hotspots.map((hotspot) => hotspot.id));
  const resolved: Hotspot[] = [];
  const persisting: { before: Hotspot; after: Hotspot }[] = [];
  for (const hotspot of before.hotspots) {
    const match = afterById.get(hotspot.id);
    if (!match) resolved.push(hotspot);
    else persisting.push({ before: hotspot, after: match });
  }
  const added = after.hotspots.filter((hotspot) => !beforeIds.has(hotspot.id));
  return { resolved, added, persisting };
}

export function gateCode(verdict: Verdict, min: number): 0 | 1 | 2 {
  switch (verdict.kind) {
    case "scored":
      return verdict.score >= min ? 0 : 1;
    case "inconclusive":
    case "unreachable":
    case "needs_backend":
      return 2;
    default:
      return assertNever(verdict);
  }
}

export function sessionFinal(session: Session): string {
  return preReport(session) ?? "unreported";
}
