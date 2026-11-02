import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { assertClean, ocrImage, PrivacyError } from "./privacy.ts";
import type { Run } from "./types.ts";

const execFileAsync = promisify(execFile);

export function loadRun(dir: string): Run {
  return JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as Run;
}

function card(caption: string, image?: string): string {
  const img = image ? `<img alt="" src="data:image/png;base64,${image}">` : "";
  const cap = caption.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  return `<!doctype html><meta charset=utf-8><style>
    html,body{margin:0;background:#0f172a;color:#f8fafc;font-family:sans-serif;width:800px;height:560px;overflow:hidden}
    .cap{color:#fbbf24;font-size:22px;font-weight:700;padding:18px 22px 8px}
    img{display:block;margin:8px auto 0;max-width:760px;max-height:470px;border-radius:8px}
    h1{font-size:42px;margin:120px 40px 12px}
    p{font-size:22px;margin:0 40px;color:#e2e8f0}
  </style><body><div class=cap>${cap}</div>${img}</body>`;
}

async function pngs(page: import("playwright").Page, htmls: string[], dir: string): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < htmls.length; i++) {
    await page.setViewportSize({ width: 800, height: 560 });
    await page.setContent(htmls[i], { waitUntil: "load" });
    const file = path.join(dir, `card-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  return files;
}

export async function writeGif(opts: { badDir: string; fixedDir?: string; gif: string }): Promise<void> {
  const bad = loadRun(opts.badDir);
  assertClean(JSON.stringify(bad));
  const frames = bad.sessions.flatMap((s) => s.frames.map((f) => ({ ...f, label: s.label, abs: f.shot ? path.join(opts.badDir, f.shot) : "" })));
  const want = [
    (c: string) => /lands/i.test(c),
    (c: string) => /empty/i.test(c),
    (c: string) => /tabs/i.test(c),
    (c: string) => /thumb/i.test(c),
    (c: string) => /listens|names/i.test(c),
    (c: string) => /opens every link/i.test(c),
  ];
  const picked: typeof frames = [];
  const used = new Set<number>();
  for (const pred of want) {
    const i = frames.findIndex((f, idx) => !used.has(idx) && pred(f.caption));
    if (i >= 0) { used.add(i); picked.push(frames[i]); }
  }
  for (const f of frames) {
    if (picked.length >= 10) break;
    if (!used.has(frames.indexOf(f)) && f.abs && fs.existsSync(f.abs)) picked.push(f);
  }
  const score = bad.verdict.kind === "scored" ? bad.verdict.score : "inconclusive";
  const top = bad.hotspots[0];
  const tripped = top ? `${top.control} tripped up ${top.personas.length} of ${bad.sessions.length} personas` : "No hotspots";
  const htmls = [
    card("First-Run Lab", undefined).replace("<div class=cap>First-Run Lab</div>", `<h1>Pinecrest Bake Sale</h1><p>Five synthetic first-time users walk a local sign-up page.</p>`),
  ];
  for (const f of picked) {
    if (!f.abs || !fs.existsSync(f.abs)) continue;
    htmls.push(card(`${f.label}: ${f.caption}`, fs.readFileSync(f.abs).toString("base64")));
  }
  htmls.push(card(`Report: ${tripped}. Score ${score}/100`));
  if (opts.fixedDir && fs.existsSync(path.join(opts.fixedDir, "run.json"))) {
    const fixed = loadRun(opts.fixedDir);
    assertClean(JSON.stringify(fixed));
    const s = fixed.verdict.kind === "scored" ? fixed.verdict.score : fixed.verdict.kind;
    htmls.push(card(`After the fix: ${s}/100`));
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frl-gif-"));
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
    const files = await pngs(page, htmls, tmp);
    for (const file of files) assertClean(await ocrImage(file));
    const gifTmp = path.join(tmp, "demo.gif");
    await execFileAsync("ffmpeg", [
      "-y", "-framerate", "1", "-i", path.join(tmp, "card-%02d.png"),
      "-vf", "split[s0][s1];[s0]palettegen=max_colors=48:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer",
      "-loop", "0", gifTmp,
    ]);
    const exploded = path.join(tmp, "exp");
    fs.mkdirSync(exploded);
    await execFileAsync("ffmpeg", ["-y", "-i", gifTmp, path.join(exploded, "f%03d.png")]);
    for (const name of fs.readdirSync(exploded)) assertClean(await ocrImage(path.join(exploded, name)));
    fs.mkdirSync(path.dirname(path.resolve(opts.gif)), { recursive: true });
    fs.copyFileSync(gifTmp, opts.gif);
  } catch (e) {
    if (fs.existsSync(opts.gif)) fs.rmSync(opts.gif);
    if (e instanceof PrivacyError) throw e;
    throw e;
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
