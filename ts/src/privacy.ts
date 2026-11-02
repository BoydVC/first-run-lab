import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PII: { name: string; re: RegExp }[] = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.\w+/ },
  { name: "phone", re: /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/ },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

export function denylistWords(): string[] {
  const path = process.env.FRL_DENYLIST || join(homedir(), ".frl", "denylist");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

/** Returns the names of patterns that hit. Callers must not write a run when this is non-empty. */
export function privacyHits(text: string, deny = denylistWords()): string[] {
  const hits: string[] = [];
  for (const p of PII) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) hits.push(p.name);
  }
  for (const w of deny) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) hits.push(`denylist:${w}`);
  }
  return hits;
}

export class PrivacyError extends Error {
  exitCode = 3;
  constructor(hits: string[]) {
    super(`privacy scan failed: ${hits.join(", ")}`);
    this.name = "PrivacyError";
  }
}

export class RefusalError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "RefusalError";
    this.exitCode = exitCode;
  }
}
