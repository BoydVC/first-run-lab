import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Persona } from "./types.js";

/** The five ship personas. Extra JSON files (tablet-kid) stay opt-in so example scores match v1. */
export const SHIP_IDS = ["skimmer", "keyboard", "phone", "screenreader", "curious"];

export function personasDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "personas");
}

export function loadAllPersonas(dir = personasDir()): Persona[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Persona);
}

export function selectPersonas(ids: string[] | undefined, dir = personasDir()): Persona[] {
  const all = loadAllPersonas(dir);
  const want = ids && ids.length ? ids : SHIP_IDS;
  return want.map((id) => {
    const found = all.find((p) => p.id === id);
    if (!found) throw new Error(`unknown persona ${id}`);
    return found;
  });
}
