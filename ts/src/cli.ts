#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatTerminal } from "./copy.js";
import { personaFromJson, runUrl, serveStatic, type RunOptions } from "./engine.js";
import { renderDiff } from "./report.js";
import { startDashboard } from "./serve.js";
import { diffRuns, gateCode } from "./merge.js";
import { TargetRefusedError } from "./observe.js";
import { BUILTIN_PERSONAS } from "./personas.js";
import { PrivacyError } from "./privacy.js";
import { readPng, encodeGif, writeGif, privacyScanMedia } from "./replay.js";
import { launchApp, leaderboard, prepareStatic, readHints } from "./sweep.js";
import { assertNever, type Persona, type Run, type Verdict } from "./types.js";

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function loadPersonas(names: string | undefined): readonly Persona[] {
  if (!names) return BUILTIN_PERSONAS;
  const wanted = new Set(names.split(",").map((item) => item.trim()).filter(Boolean));
  const extras: Persona[] = [];
  const dir = resolve("personas");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      extras.push(personaFromJson(JSON.parse(readFileSync(join(dir, file), "utf8"))));
    }
  }
  const all = [...BUILTIN_PERSONAS, ...extras];
  const picked = all.filter((persona) => wanted.has(persona.id));
  if (picked.length === 0) throw new Error(`no personas matched ${names}`);
  return picked;
}

function readRun(path: string): Run {
  const file = path.endsWith(".json") ? path : join(path, "run.json");
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  return raw as Run;
}

async function targetUrl(target: string, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return { url: target, close: async () => {} };
  }
  const { statSync } = await import("node:fs");
  const abs = resolve(target);
  const info = statSync(abs);
  if (info.isDirectory()) {
    const server = await serveStatic(abs, port);
    return { url: server.url, close: server.close };
  }
  const server = await serveStatic(dirname(abs), port);
  return { url: new URL(abs.split("/").pop() ?? "index.html", server.url).href, close: server.close };
}

function printRun(run: Run, reportPath = ""): number {
  process.stdout.write(formatTerminal(run, reportPath));
  if (run.verdict.kind === "scored") return 0;
  return 2;
}

function optionsFrom(argv: string[]): RunOptions {
  const kindFlag = flag(argv, "--kind");
  const kind = kindFlag === "form" || kindFlag === "dashboard" || kindFlag === "auto" ? kindFlag : "auto";
  const budget = Number(flag(argv, "--budget") ?? "12");
  const allow = (flag(argv, "--allow") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const redact = (flag(argv, "--redact") ?? process.env.FRL_REDACT ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return { kind, budget, allow, redact, personas: loadPersonas(flag(argv, "--personas")), screenshots: argv.includes("--shots") };
}

async function cmdRun(argv: string[]): Promise<number> {
  const target = positionals(argv)[0];
  if (!target) throw new Error("frl run <url>");
  const port = Number(flag(argv, "--port") ?? "8765");
  const out = flag(argv, "--out") ?? "runs/latest";
  const opened = await targetUrl(target, port);
  try {
    const run = await runUrl(opened.url, { ...optionsFrom(argv), out });
    return printRun(run, join(out, "report.html"));
  } finally {
    await opened.close();
  }
}

async function cmdGate(argv: string[]): Promise<number> {
  const target = positionals(argv)[0];
  if (!target) throw new Error("frl gate <url> --min 80");
  const min = Number(flag(argv, "--min") ?? "80");
  const port = Number(flag(argv, "--port") ?? "8765");
  const out = flag(argv, "--out");
  const opened = await targetUrl(target, port);
  try {
    const run = await runUrl(opened.url, { ...optionsFrom(argv), ...(out ? { out } : {}) });
    const code = gateCode(run.verdict, min);
    console.log(code === 0 ? `gate pass ${scoreText(run.verdict)}` : `gate fail ${scoreText(run.verdict)}`);
    return code;
  } finally {
    await opened.close();
  }
}

function scoreText(verdict: Verdict): string {
  switch (verdict.kind) {
    case "scored":
      return String(verdict.score);
    case "inconclusive":
      return `inconclusive (${verdict.crashed.join(", ")})`;
    case "unreachable":
    case "needs_backend":
      return `${verdict.kind}: ${verdict.detail}`;
    default:
      return assertNever(verdict);
  }
}

function cmdDiff(argv: string[]): number {
  const [left, right] = positionals(argv);
  if (!left || !right) throw new Error("frl diff <runA> <runB>");
  const diff = diffRuns(readRun(left), readRun(right));
  console.log(`resolved ${diff.resolved.length}`);
  for (const hotspot of diff.resolved) console.log(`  resolved ${hotspot.id} ${hotspot.control}`);
  console.log(`added ${diff.added.length}`);
  for (const hotspot of diff.added) console.log(`  added ${hotspot.id} ${hotspot.control}`);
  console.log(`persisting ${diff.persisting.length}`);
  const htmlOut = flag(argv, "--html");
  if (htmlOut) {
    writeFileSync(htmlOut, renderDiff(readRun(left), readRun(right)));
    console.log(`diff report: ${htmlOut}`);
  }
  return 0;
}

async function cmdReplay(argv: string[]): Promise<number> {
  const runPath = positionals(argv)[0];
  const gif = flag(argv, "--gif");
  if (!runPath || !gif) throw new Error("frl replay <run> --gif demo.gif");
  const run = readRun(runPath);
  const root = runPath.endsWith(".json") ? dirname(runPath) : runPath;
  const pngs = run.sessions.flatMap((session) => session.frames.map((frame) => join(root, frame.shot))).filter((shot) => shot.endsWith(".png"));
  if (pngs.length === 0) throw new Error("run has no frames; re-run with --shots");
  const frames = pngs.map((path) => readPng(path));
  const bytes = encodeGif(frames);
  const scan = await privacyScanMedia([join(root, "run.json"), ...pngs]);
  if (scan.hits.length > 0) throw new PrivacyError(scan.hits);
  writeGif(gif, bytes);
  const gifScan = await privacyScanMedia([gif]);
  if (gifScan.hits.length > 0) {
    const { rmSync } = await import("node:fs");
    rmSync(gif, { force: true });
    throw new PrivacyError(gifScan.hits);
  }
  console.log(`gif ${gif} (${bytes.length} bytes)`);
  return 0;
}

async function cmdSweep(argv: string[]): Promise<number> {
  const ports = flag(argv, "--ports");
  const root = flag(argv, "--root") ?? positionals(argv)[0];
  const out = flag(argv, "--out") ?? "sweep.json";
  const rows: { name: string; url: string; score: number | null; verdict: string; kind: string }[] = [];
  if (ports) {
    const [startRaw, endRaw] = ports.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw ?? startRaw);
    for (let port = start; port <= end; port += 1) {
      const url = `http://127.0.0.1:${port}/`;
      try {
        const status = await fetch(url);
        if (!status.ok && status.status !== 200) continue;
        const run = await runUrl(url, optionsFrom(argv));
        rows.push(toRow(String(port), run));
      } catch {
        /* closed port */
      }
    }
  } else if (root) {
    const { readdirSync, existsSync } = await import("node:fs");
    const hints = readHints(flag(argv, "--hints"));
    const names = readdirSync(root).filter((name) => !name.startsWith("_") && !name.startsWith("."));
    let port = 8900;
    for (const name of names) {
      const repo = join(root, name);
      if (!existsSync(repo)) continue;
      const hint = (await import("./sweep.js")).startHint(repo, hints);
      if (hint) {
        const launched = await launchApp(repo, port, hints);
        try {
          const run = await runUrl(launched.url, optionsFrom(argv));
          rows.push(toRow(name, run));
        } finally {
          launched.stop();
        }
      } else if (existsSync(join(repo, "index.html")) || existsSync(join(repo, "web", "index.html"))) {
        const prepared = await prepareStatic(root, name);
        const server = await serveStatic(prepared.dir, port);
        try {
          const run = await runUrl(new URL(prepared.page, server.url).href, optionsFrom(argv));
          rows.push(toRow(name, run));
        } finally {
          await server.close();
        }
      }
      port += 1;
    }
  } else {
    throw new Error("frl sweep --ports 4300-4399 | --root DIR");
  }
  const board = leaderboard(rows);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, JSON.stringify(board, null, 1));
  for (const row of board) console.log(`${row.score ?? row.verdict}\t${row.name}`);
  return 0;
}

function toRow(name: string, run: Run): { name: string; url: string; score: number | null; verdict: string; kind: string } {
  return {
    name,
    url: run.url,
    score: run.verdict.kind === "scored" ? run.verdict.score : null,
    verdict: run.verdict.kind,
    kind: run.kind,
  };
}

async function cmdServe(argv: string[]): Promise<number> {
  const port = Number(flag(argv, "--port") ?? "0");
  const dir = flag(argv, "--runs") ?? "runs";
  const sweep = flag(argv, "--sweep");
  const dash = await startDashboard({ port, runsDir: dir, sweepFile: sweep });
  console.log(`dashboard http://127.0.0.1:${dash.port}/`);
  await new Promise(() => {});
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const cmd = argv[0];
    if (cmd === "run") return await cmdRun(argv.slice(1));
    if (cmd === "gate") return await cmdGate(argv.slice(1));
    if (cmd === "diff") return cmdDiff(argv.slice(1));
    if (cmd === "replay") return await cmdReplay(argv.slice(1));
    if (cmd === "sweep") return await cmdSweep(argv.slice(1));
    if (cmd === "serve") return await cmdServe(argv.slice(1));
    console.error("usage: frl run|diff|gate|replay|sweep|serve");
    return 2;
  } catch (error) {
    if (error instanceof TargetRefusedError) {
      console.error(error.message);
      return 64;
    }
    if (error instanceof PrivacyError) {
      console.error(error.message);
      return 3;
    }
    console.error(error instanceof Error ? error.message : "error");
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
