import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { run } from "./src/engine.ts";
import { BUILTIN } from "./src/personas.ts";
import { REPO_ROOT } from "./src/root.ts";
import { serveDir } from "./src/static.ts";

const pages = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const out: Record<string, unknown> = {};
try {
  for (const rel of pages) {
    const abs = path.join(REPO_ROOT, rel);
    const srv = await serveDir(path.dirname(abs));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frl-v2-"));
    try {
      const rep = await run({
        url: new URL(path.basename(abs), srv.url).href,
        out: dir,
        personas: BUILTIN,
        kind: "auto",
        shots: false,
        browser,
      });
      out[rel] = {
        score: rep.verdict.kind === "scored" ? rep.verdict.score : null,
        verdict: rep.verdict.kind === "scored" ? "scored" : rep.verdict.kind === "inconclusive" ? "inconclusive" : `${rep.verdict.kind}: ${rep.verdict.detail}`,
        hotspots: rep.hotspots.map((h) => ({ id: h.id, control: h.control, severity: h.severity, kinds: h.kinds, personas: h.personas })),
      };
      console.error(rel, out[rel]);
    } finally {
      await srv.close();
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(REPO_ROOT, "spec", "parity-v2.json"), JSON.stringify(out, null, 2));
