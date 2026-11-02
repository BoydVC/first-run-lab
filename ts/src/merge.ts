import { createHash } from "node:crypto";
import type { Finding, Hotspot, Severity } from "./types.ts";

export const SEV: Record<Severity, number> = { blocker: 3, major: 2, minor: 1 };

export function hotspotId(control: string): `F${string}` {
  return `F${createHash("sha1").update(control).digest("hex").slice(0, 6)}` as `F${string}`;
}

/** Group findings by control. Every finding is kept (details.length is the bag size). */
export function merge(findings: Finding[]): Hotspot[] {
  const map = new Map<string, Hotspot>();
  for (const f of findings) {
    const key = String(f.control);
    let h = map.get(key);
    if (!h) {
      h = {
        id: hotspotId(key),
        control: f.control,
        severity: f.severity,
        kinds: [],
        personas: [],
        details: [],
        evidence: f.evidence,
      };
      map.set(key, h);
    }
    if (!h.kinds.includes(f.kind)) h.kinds.push(f.kind);
    h.details.push(f.detail);
    if (!h.personas.includes(f.persona)) h.personas.push(f.persona);
    if (SEV[f.severity] > SEV[h.severity]) {
      h.severity = f.severity;
      h.evidence = f.evidence;
    }
  }
  for (const h of map.values()) {
    h.kinds.sort((a, b) => {
      const ra = Math.max(...findings.filter((f) => f.control === h.control && f.kind === a).map((f) => SEV[f.severity]));
      const rb = Math.max(...findings.filter((f) => f.control === h.control && f.kind === b).map((f) => SEV[f.severity]));
      return rb - ra || a.localeCompare(b);
    });
  }
  return [...map.values()].sort(
    (a, b) =>
      SEV[b.severity] - SEV[a.severity] ||
      b.personas.length - a.personas.length ||
      String(a.control).localeCompare(String(b.control)),
  );
}
