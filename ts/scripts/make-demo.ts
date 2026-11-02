/**
 * Build screenshots/demo-ts.gif from the synthetic Pinecrest pages only.
 * About 14 frames, captions baked in, privacy-scanned (regex + OCR) before the file is kept.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { spawnSync } from "node:child_process";
import { executeRun } from "../src/engine.js";
import { headline } from "../src/copy.js";
import { renderDiff } from "../src/report.js";
import { staticServer } from "../src/sweep.js";
import { privacyHits, PrivacyError } from "../src/privacy.js";
import { writeFileSync } from "node:fs";

const repo = join(import.meta.dirname, "..", "..");
const outGif = join(repo, "screenshots", "demo-ts.gif");

function card(caption: string, img?: string, zoom = false): string {
  const safe = caption.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const picture = img ? `<img alt="" src="${img}" class="${zoom ? "zoom" : ""}">` : `<p class="big">${safe}</p>`;
  const cap = img ? `<div class="cap">${safe}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#1c1917;color:#f6f1e7;font-family:"DejaVu Sans",Inter,sans-serif;width:800px;height:560px;overflow:hidden}
    .cap{height:72px;padding:16px 20px 0;font:700 26px/1.15 "DejaVu Sans",sans-serif;color:#fbbf24}
    .stage{height:${img ? 480 : 560}px;display:flex;align-items:center;justify-content:center;padding:0 16px 12px}
    img{max-width:760px;max-height:450px;background:#fff;border-radius:8px}
    img.zoom{width:520px;max-width:90%;height:auto;max-height:440px}
    .big{font:700 40px/1.2 "DejaVu Sans",sans-serif;color:#fbbf24;text-align:center;padding:0 40px;margin:0}
  </style></head><body>${cap}<div class="stage">${picture}</div></body></html>`;
}

async function snap(page: Page, file: string, caption: string, img?: string, zoom = false): Promise<void> {
  await page.setContent(card(caption, img, zoom));
  await page.screenshot({ path: file });
  const text = spawnSync("tesseract", [file, "-"], { encoding: "utf8" }).stdout || "";
  const hits = privacyHits(caption + "\n" + text);
  if (hits.length) throw new PrivacyError(hits);
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "frl-demo-"));
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const srv = await staticServer(join(repo, "examples"));
  try {
    const badDir = join(work, "bad");
    const fixedDir = join(work, "fixed");
    const bad = await executeRun({
      url: `http://127.0.0.1:${srv.port}/signup.html`, out: badDir, browser, kind: "form", evidence: true, frames: true,
    });
    const fixed = await executeRun({
      url: `http://127.0.0.1:${srv.port}/signup-fixed.html`, out: fixedDir, browser, kind: "form", evidence: true, frames: true,
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
    const frames: { file: string; caption: string; img?: string; zoom?: boolean }[] = [];
    const add = (caption: string, img?: string, zoom = false) => {
      const file = join(work, `f${String(frames.length + 1).padStart(2, "0")}.png`);
      frames.push({ file, caption, img, zoom });
    };
    add("Five first-time users try Pinecrest Bake Sale");
    for (const s of bad.sessions) {
      const landing = s.frames.find((f) => /lands/i.test(f.caption));
      if (landing) add(landing.caption, pathToFileURL(join(badDir, landing.shot)).href);
    }
    const shot = (control: string) => {
      const h = bad.hotspots.find((x) => x.control === control);
      return h?.evidence.shot ? pathToFileURL(join(badDir, h.evidence.shot)).href : undefined;
    };
    add("Skimmer clicks Sign up. Nothing happens.", shot("Sign up"), true);
    const tab = bad.sessions.find((s) => s.persona === "keyboard")?.frames.find((f) => /tab/i.test(f.caption));
    add("Keyboard user tabs past the fake Sign up button", tab ? pathToFileURL(join(badDir, tab.shot)).href : undefined);
    add("Phone user meets a tiny menu button", shot("☰"), true);
    const hear = bad.sessions.find((s) => s.persona === "screenreader")?.frames.find((f) => /listen/i.test(f.caption));
    add("Screen reader hears no name on the menu", hear ? pathToFileURL(join(badDir, hear.shot)).href : shot("☰"));
    add("Curious user opens a dead link", shot("Allergy info"), true);
    await page.goto(pathToFileURL(join(badDir, "report.html")).href);
    const reportPng = join(work, "report.png");
    await page.screenshot({ path: reportPng });
    add(headline(bad), pathToFileURL(reportPng).href);
    writeFileSync(join(work, "diff.html"), renderDiff(bad, fixed));
    await page.goto(pathToFileURL(join(work, "diff.html")).href);
    const diffPng = join(work, "diff.png");
    await page.screenshot({ path: diffPng });
    add("Before and after the fix", pathToFileURL(diffPng).href);
    await page.goto(pathToFileURL(join(fixedDir, "report.html")).href);
    const fixedPng = join(work, "fixed.png");
    await page.screenshot({ path: fixedPng });
    add("After the fix: 100 / 100", pathToFileURL(fixedPng).href);

    if (frames.length < 12 || frames.length > 16) throw new Error(`expected about 14 frames, got ${frames.length}`);
    for (const f of frames) await snap(page, f.file, f.caption, f.img, f.zoom);

    const enc = spawnSync("ffmpeg", [
      "-y", "-framerate", "1", "-i", join(work, "f%02d.png"),
      "-vf", "scale=800:560:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80:stats_mode=diff[p];[s1][p]paletteuse",
      "-loop", "0", outGif,
    ], { stdio: "inherit" });
    if (enc.status !== 0) throw new Error("ffmpeg failed");
    const { scanGif } = await import("../src/replay.js");
    scanGif(outGif);
    const { statSync } = await import("node:fs");
    const bytes = statSync(outGif).size;
    if (bytes > 1_000_000) throw new Error(`gif is ${bytes} bytes`);
    console.log(outGif, frames.length, "frames", Math.round(bytes / 1024), "KB");
  } finally {
    await browser.close();
    await srv.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
