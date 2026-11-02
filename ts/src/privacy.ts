import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PII = [/[A-Za-z0-9.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9]+/, /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/, /\b\d{3}-\d{2}-\d{4}\b/];

export class PrivacyError extends Error {
  code = 3;
  hits: string[];
  constructor(hits: string[]) {
    super(`privacy scan failed: ${hits.join(", ")}`);
    this.name = "PrivacyError";
    this.hits = hits;
  }
}

export function denylist(file = path.join(os.homedir(), ".frl", "denylist")): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
}

export function piiHits(text: string, extra: string[] = denylist()): string[] {
  const hits: string[] = [];
  for (const p of PII) {
    p.lastIndex = 0;
    if (p.test(text)) hits.push(p.source);
  }
  for (const w of extra) {
    if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) hits.push(w);
  }
  return hits;
}

export function assertClean(text: string, extra?: string[]): void {
  const hits = piiHits(text, extra);
  if (hits.length) throw new PrivacyError(hits);
}

export async function ocrImage(png: string): Promise<string> {
  const { stdout } = await execFileAsync("tesseract", [png, "-"], { maxBuffer: 4_000_000 });
  return stdout;
}

export function redact(text: string, words: string[]): string {
  let out = text;
  for (const w of words) {
    const word = w.trim();
    if (!word) continue;
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  }
  return out;
}
