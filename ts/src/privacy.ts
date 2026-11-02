import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.\w+/ },
  { name: "phone", re: /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/ },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

export class PrivacyError extends Error {
  readonly hits: readonly string[];
  readonly exitCode = 3;
  constructor(hits: readonly string[]) {
    super(`privacy scan failed: ${hits.join(", ")}`);
    this.name = "PrivacyError";
    this.hits = hits;
  }
}

export function loadDenylist(path = join(homedir(), ".frl", "denylist")): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function privacyHits(text: string, denylist: readonly string[] = loadDenylist()): string[] {
  const hits: string[] = [];
  for (const pattern of PATTERNS) {
    if (pattern.re.test(text)) hits.push(pattern.name);
  }
  for (const word of denylist) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) hits.push(`denylist:${word}`);
  }
  return hits;
}

export function assertClean(text: string, denylist?: readonly string[]): void {
  const hits = privacyHits(text, denylist ?? loadDenylist());
  if (hits.length > 0) throw new PrivacyError(hits);
}
