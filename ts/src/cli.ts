#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeRun, loadRun } from "./engine.js";
import { formatTerminal, headline } from "./copy.js";
import { renderDiff } from "./report.js";
import { startDashboard } from "./serve.js";
import { launch, prepareStatic, startHint, sweepPorts } from "./sweep.js";
import { scanGif } from "./replay.js";
import type { Run } from "./types.js";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function serveDir(root: string, page: string, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes("..")) { res.writeHead(400); res.end("bad"); return; }
    const file = join(root, rel === "/" ? page : rel);
    if (!existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200);
    res.end(readFileSync(file));
  });
  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
      const got = port || (server.address() as { port: number }).port;
      resolvePromise({
        url: `http://127.0.0.1:${got}/${page}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function parsePorts(spec: string): number[] {
  const m = spec.match(/^(\d+)-(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const ports: number[] = [];
    for (let p = a; p <= b && ports.length < 100; p++) ports.push(p);
    return ports;
  }
  return spec.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
}

function gateCode(run: Run, min: number): number {
  if (run.verdict.kind === "scored") return run.verdict.score >= min ? 0 : 1;
  return 2;
}

async function cmdRun(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) throw new Error("usage: first-run-lab run <url-or-file>");
  const outParent = resolve(arg(argv, "--out") || arg(argv, "-o") || "runs");
  const port = Number(arg(argv, "--port") || 0);
  const kind = (arg(argv, "--kind") || "auto") as "auto" | "form" | "dashboard";
  const budget = Number(arg(argv, "--budget") || 12);
  const personas = arg(argv, "--personas")?.split(",").map((s) => s.trim()).filter(Boolean);
  const redact = arg(argv, "--redact")?.split(",").map((s) => s.trim()).filter(Boolean);
  const allow = arg(argv, "--allow")?.split(",").map((s) => s.trim()).filter(Boolean);
  let close = async () => {};
  let url = target;
  if (!target.startsWith("http://") && !target.startsWith("https://")) {
    const abs = resolve(target);
    const root = existsSync(abs) && statSync(abs).isDirectory() ? abs : dirname(abs);
    const page = root === abs ? "index.html" : abs.slice(root.length + 1);
    const served = await serveDir(root, page, port);
    url = served.url;
    close = served.close;
  }
  try {
    const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const out = join(outParent, id);
    const run = await executeRun({ url, out, kind, budget, personas, redact, allow, id, evidence: true, frames: !has(argv, "--no-frames") });
    const report = join(out, "report.html");
    process.stdout.write(formatTerminal(run, existsSync(report) ? report : ""));
    if (run.verdict.kind === "scored") return 0;
    if (run.verdict.kind === "inconclusive") return 2;
    return 2;
  } finally {
    await close();
  }
}

async function cmdDiff(argv: string[]): Promise<number> {
  const [a, b] = argv.filter((x) => !x.startsWith("--"));
  if (!a || !b) throw new Error("usage: first-run-lab diff <runA> <runB>");
  const before = loadRun(resolve(a));
  const after = loadRun(resolve(b));
  const out = resolve(arg(argv, "--out") || arg(argv, "-o") || "diff.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderDiff(before, after));
  const ids = new Set(after.hotspots.map((h) => h.id));
  const resolved = before.hotspots.filter((h) => !ids.has(h.id));
  const score = (r: Run) => (r.verdict.kind === "scored" ? String(r.verdict.score) : r.verdict.kind);
  process.stdout.write(`Before  ${score(before)} / 100\nAfter   ${score(after)} / 100\n\nResolved\n`);
  for (const h of resolved) process.stdout.write(`  ${h.id}  ${h.severity}  ${h.control}\n`);
  if (!resolved.length) process.stdout.write("  (none)\n");
  process.stdout.write(`\n  report  ${out}\n`);
  return 0;
}

async function cmdGate(argv: string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith("--"));
  const min = Number(arg(argv, "--min") ?? "80");
  if (!target) throw new Error("usage: first-run-lab gate <url> --min 80");
  const code = await cmdRun([target, "--out", arg(argv, "--out") || join("runs", "gate"), "--kind", arg(argv, "--kind") || "auto", "--no-frames"]);
  if (code === 64) return 64;
  const parent = resolve(arg(argv, "--out") || join("runs", "gate"));
  const { readdirSync } = await import("node:fs");
  const dirs = existsSync(parent) ? readdirSync(parent).map((n) => join(parent, n)).filter((p) => existsSync(join(p, "run.json"))) : [];
  dirs.sort();
  const latest = dirs[dirs.length - 1];
  if (!latest) return code || 2;
  const run = loadRun(latest);
  const gate = gateCode(run, min);
  if (run.verdict.kind === "scored") process.stdout.write(`gate ${run.verdict.score} ${gate === 0 ? "pass" : "fail"} (min ${min})\n`);
  else process.stdout.write(`gate ${run.verdict.kind} (not a pass)\n`);
  return gate;
}

async function cmdReplay(argv: string[]): Promise<number> {
  const runDir = argv.find((a) => !a.startsWith("--"));
  const gif = resolve(arg(argv, "--gif") || "demo.gif");
  if (!runDir) throw new Error("usage: first-run-lab replay <run> --gif demo.gif");
  const run = loadRun(resolve(runDir));
  const dir = mkdtempSync(join(tmpdir(), "frl-replay-"));
  const frames: string[] = [];
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const cards: { caption: string; image?: string }[] = [{ caption: headline(run) }];
    for (const s of run.sessions) for (const f of s.frames) cards.push({ caption: f.caption, image: join(resolve(runDir), f.shot) });
    const page = await browser.newPage({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 });
    let n = 0;
    for (const card of cards.slice(0, 16)) {
      n++;
      const img = card.image && existsSync(card.image) ? pathToFileURL(card.image).href : "";
      await page.setContent(cardHtml(card.caption, img));
      const file = join(dir, `f${String(n).padStart(2, "0")}.png`);
      await page.screenshot({ path: file });
      frames.push(file);
    }
  } finally {
    await browser.close();
  }
  encodeGif(frames, gif);
  scanGif(gif);
  process.stdout.write(`${gif}\n`);
  return 0;
}

function encodeGif(frames: string[], gif: string): void {
  const list = join(dirname(frames[0]), "list.txt");
  const lines: string[] = [];
  for (const f of frames) lines.push(`file '${f}'`, "duration 1.2");
  lines.push(`file '${frames[frames.length - 1]}'`);
  writeFileSync(list, lines.join("\n"));
  const r = spawnSync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "fps=1,scale=800:560:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80:stats_mode=diff[p];[s1][p]paletteuse",
    "-loop", "0", gif,
  ], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed");
}

function cardHtml(caption: string, img: string): string {
  const safe = caption.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const picture = img ? `<img src="${img}" style="max-width:760px;max-height:450px">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#1c1917;color:#f6f1e7;font-family:Inter,DejaVu Sans,sans-serif;width:800px;height:560px;overflow:hidden}
    .cap{height:78px;padding:18px 22px 0;font:700 26px/1.2 Inter,sans-serif;color:#fbbf24}
    .stage{height:470px;display:flex;align-items:center;justify-content:center}
  </style></head><body><div class="cap">${safe}</div><div class="stage">${picture}</div></body></html>`;
}

async function cmdSweep(argv: string[]): Promise<number> {
  const ports = arg(argv, "--ports");
  const root = arg(argv, "--root") || argv.find((a) => !a.startsWith("--"));
  const out = resolve(arg(argv, "--out") || arg(argv, "-o") || "sweep.json");
  if (ports) {
    const res = await sweepPorts(parsePorts(ports), { out });
    process.stdout.write(`${Object.keys(res).length} apps -> ${out}\n`);
    return 0;
  }
  if (!root) throw new Error("usage: first-run-lab sweep --ports 4300-4399 | --root DIR");
  const { readdirSync, statSync } = await import("node:fs");
  const abs = resolve(root);
  const repos = readdirSync(abs).filter((n) => !n.startsWith("_") && statSync(join(abs, n)).isDirectory());
  const results: Record<string, unknown> = {};
  let port = 8900;
  for (const repo of repos) {
    const hint = startHint(join(abs, repo));
    if (hint) {
      const outDir = join(abs, "_out", repo);
      const run = await launch(join(abs, repo), port++, (url) => executeRun({ url, out: outDir, evidence: false, kind: "auto" }));
      results[repo] = { score: run.verdict.kind === "scored" ? run.verdict.score : null, verdict: run.verdict.kind, hotspots: run.hotspots };
    } else if (existsSync(join(abs, repo, "web", "index.html")) || existsSync(join(abs, repo, "index.html"))) {
      const prepared = prepareStatic(abs, repo);
      const served = await serveDir(prepared.dir, prepared.page, port++);
      try {
        const run = await executeRun({ url: served.url, out: join(abs, "_out", repo), evidence: false, kind: "auto" });
        results[repo] = { score: run.verdict.kind === "scored" ? run.verdict.score : null, verdict: run.verdict.kind, hotspots: run.hotspots, backend: prepared.how };
      } finally { await served.close(); }
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
  process.stdout.write(`${Object.keys(results).length} apps -> ${out}\n`);
  return 0;
}

async function cmdServe(argv: string[]): Promise<number> {
  const port = Number(arg(argv, "--port") || 4310);
  const runsDir = resolve(arg(argv, "--dir") || "runs");
  const sweepFile = arg(argv, "--sweep");
  const dash = await startDashboard({ port, runsDir, sweepFile: sweepFile ? resolve(sweepFile) : undefined });
  process.stdout.write(`First-Run Lab dashboard  http://127.0.0.1:${dash.port}/\n`);
  await new Promise(() => {});
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "run") return await cmdRun(rest);
    if (cmd === "diff") return await cmdDiff(rest);
    if (cmd === "gate") return await cmdGate(rest);
    if (cmd === "replay") return await cmdReplay(rest);
    if (cmd === "sweep") return await cmdSweep(rest);
    if (cmd === "serve") return await cmdServe(rest);
    process.stdout.write(`First-Run Lab

  npx first-run-lab run http://127.0.0.1:PORT

Five synthetic first-time users walk a local page. The terminal prints who got stuck
and the path to an HTML report.

  run <url|file> [--personas a,b] [--budget 12] [--out runs] [--kind auto|form|dashboard] [--redact a,b]
  diff <runA> <runB>
  gate <url> --min 80
  replay <run> --gif demo.gif
  sweep --ports 4300-4399 | --root DIR
  serve [--port 4310] [--dir runs] [--sweep sweep.json]
`);
    return cmd ? 1 : 0;
  } catch (e) {
    const code = e && typeof e === "object" && "exitCode" in e ? Number((e as { exitCode: number }).exitCode) : 1;
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return code;
  }
}

const isDirect = process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));
if (isDirect) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
