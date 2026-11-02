/**
 * Build screenshots/demo-ts.gif from a real run on the synthetic bake-sale fixtures.
 * The file is written only after a regex + OCR privacy scan comes back clean.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runUrl, serveStatic } from "./engine.js";
import { launchBrowser } from "./observe.js";
import { encodeGif, paintRing, privacyScanMedia, readPng, scalePng, writeGif } from "./replay.js";
import type { Run } from "./types.js";

const repo = join(import.meta.dirname, "..", "..");

function scoreOf(run: Run): string {
  return run.verdict.kind === "scored" ? String(run.verdict.score) : run.verdict.kind;
}

function signups(run: Run): number {
  return run.hotspots.find((hotspot) => hotspot.control === "Sign up")?.personas.length ?? 0;
}

async function card(browser: Awaited<ReturnType<typeof launchBrowser>>, title: string, body: string): Promise<PNG> {
  const page = await browser.newPage({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;
      background:#f6f1e7;color:#1c1915;font-family:Georgia,serif;text-align:center}
    h1{font-size:46px;margin:0 24px} p{font-size:28px;margin:12px 48px}
  </style><h1>${title}</h1><p>${body}</p>`);
  const buffer = await page.screenshot();
  await page.close();
  return PNG.sync.read(buffer);
}

function framePng(dir: string, run: Run, persona: string, captionPart: string): PNG | null {
  const session = run.sessions.find((item) => item.persona === persona);
  const frame = session?.frames.find((item) => item.caption.includes(captionPart) && !item.caption.includes("fills the form"));
  if (!frame?.shot) return null;
  return scalePng(readPng(join(dir, frame.shot)), 800, 560);
}

function shotPng(dir: string, run: Run, control: string): PNG | null {
  const hotspot = run.hotspots.find((item) => item.control === control);
  const shot = hotspot?.evidence.shot;
  if (!shot) return null;
  try {
    return paintRing(readPng(join(dir, shot)));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "frl-demo-"));
  const badDir = join(work, "bad");
  const fixedDir = join(work, "fixed");
  const browser = await launchBrowser();
  const server = await serveStatic(join(repo, "examples"));
  let bad: Run;
  let fixed: Run;
  try {
    bad = await runUrl(new URL("signup.html", server.url).href, { browser, kind: "auto", out: badDir, screenshots: true });
    fixed = await runUrl(new URL("signup-fixed.html", server.url).href, { browser, kind: "auto", out: fixedDir, screenshots: true });
  } finally {
    await server.close();
  }
  console.log(`demo scores bad=${scoreOf(bad)} fixed=${scoreOf(fixed)} signups=${signups(bad)}`);
  const frames: PNG[] = [
    await card(browser, "Pinecrest Bake Sale", "Five synthetic first-time users try the sign-up page."),
  ];
  for (const id of ["skimmer", "keyboard", "phone", "screenreader", "curious"]) {
    const landing = framePng(badDir, bad, id, "lands on the page");
    if (landing) frames.push(landing);
  }
  const empty = framePng(badDir, bad, "skimmer", "empty");
  if (empty) frames.push(empty);
  const signup = shotPng(badDir, bad, "Sign up");
  if (signup) frames.push(signup);
  const menu = shotPng(badDir, bad, "\u2630");
  if (menu) frames.push(menu);
  for (const part of ["tabs through", "thumb-size", "control names", "every link"]) {
    const id = part.startsWith("tabs") ? "keyboard" : part.startsWith("thumb") ? "phone" : part.startsWith("control") ? "screenreader" : "curious";
    const png = framePng(badDir, bad, id, part);
    if (png) frames.push(png);
  }
  frames.push(await card(browser, `${scoreOf(bad)} / 100`, `Sign up tripped up ${signups(bad)} of 5 personas.`));
  const fixedLanding = framePng(fixedDir, fixed, "skimmer", "lands on the page");
  if (fixedLanding) frames.push(fixedLanding);
  frames.push(await card(browser, `${scoreOf(fixed)} / 100`, "The fixed page. Every session finished."));
  await browser.close();

  const pngDir = join(work, "gif-frames");
  mkdirSync(pngDir, { recursive: true });
  const pngPaths: string[] = [];
  frames.forEach((frame, index) => {
    const path = join(pngDir, `${String(index).padStart(2, "0")}.png`);
    writeFileSync(path, PNG.sync.write(frame));
    pngPaths.push(path);
  });
  const scan = await privacyScanMedia([join(badDir, "run.json"), join(fixedDir, "run.json"), ...pngPaths], []);
  if (scan.hits.length > 0) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`privacy scan failed before gif write: ${scan.hits.join(", ")}`);
  }
  const bytes = encodeGif(frames, 700);
  const gifPath = join(work, "demo-ts.gif");
  writeGif(gifPath, bytes);
  const gifScan = await privacyScanMedia([gifPath], []);
  if (gifScan.hits.length > 0) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`gif OCR failed: ${gifScan.hits.join(", ")} :: ${gifScan.text.slice(0, 240)}`);
  }
  const dest = join(repo, "screenshots", "demo-ts.gif");
  mkdirSync(join(repo, "screenshots"), { recursive: true });
  copyFileSync(gifPath, dest);
  console.log(`wrote ${dest} (${bytes.length} bytes, ${frames.length} frames)`);
  console.log(`ocr sample: ${gifScan.text.replace(/\s+/g, " ").slice(0, 300)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
