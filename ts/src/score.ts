import { createHash } from "node:crypto";
import { SEV_RANK } from "./copy.js";
import type { Finding, Hotspot, Session, Severity } from "./types.js";

export function scoreHotspots(hotspots: { severity: Severity }[]): number {
  const pen = { blocker: 0, major: 0, minor: 0 };
  for (const h of hotspots) pen[h.severity] += 1;
  return Math.max(0, 100 - Math.min(60, 20 * pen.blocker) - Math.min(30, 6 * pen.major) - Math.min(10, 2 * pen.minor));
}

/** Group findings by control. Stable sort: severity, then persona count, then first-seen order. */
export function merge(sessions: Session[]): Hotspot[] {
  const order: string[] = [];
  const hot = new Map<string, Hotspot>();
  for (const s of sessions) {
    for (const f of s.findings) {
      let h = hot.get(f.control);
      if (!h) {
        h = {
          id: hotspotId(f.control),
          control: f.control,
          severity: f.severity,
          kinds: [],
          personas: [],
          details: [],
          evidence: f.evidence,
        };
        hot.set(f.control, h);
        order.push(f.control);
      }
      if (!h.kinds.includes(f.kind)) h.kinds.push(f.kind);
      h.details.push(f.detail);
      if (!h.personas.includes(f.persona)) h.personas.push(f.persona);
      if (SEV_RANK[f.severity] > SEV_RANK[h.severity]) h.severity = f.severity;
    }
  }
  const list = order.map((k) => hot.get(k)!);
  list.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.personas.length - a.personas.length);
  return list;
}

export function hotspotId(control: string): `F${string}` {
  return ("F" + createHash("sha1").update(control).digest("hex").slice(0, 6)) as `F${string}`;
}

export function findingCount(sessions: Session[]): number {
  return sessions.reduce((n, s) => n + s.findings.length, 0);
}

export function representedFindings(hotspots: Hotspot[]): number {
  return hotspots.reduce((n, h) => n + h.details.length, 0);
}

export function addFinding(session: Session, finding: Finding): void {
  session.findings.push(finding);
}
