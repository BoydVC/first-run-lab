import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { diffRuns } from "./diff.ts";
import { dashboardHtml } from "./dashboard.ts";
import { gateCode, RefuseHost, run } from "./engine.ts";
import { loadPersonas } from "./personas.ts";
import { PrivacyError } from "./privacy.ts";
import { loadRun, writeGif } from "./replay.ts";
import { REPO_ROOT } from "./root.ts";
import { serveDir } from "./static.ts";
import { sortBoard, sweepUrls } from "./sweep.ts";
import type { Run } from "./types.ts";

interface Flags { [k: string]: string | boolean | string[]; _: string[] }

function parse(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else flags._.push(a);
  }
  return flags;
}

async function targetUrl(target: string, portFlag?: string): Promise<{ url: string; close?: () => Promise<void> }> {
  if (target.startsWith("http://") || target.startsWith("https://")) return { url: target };
  const abs = path.resolve(target);
  const root = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const page = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "" : path.basename(abs);
  const srv = await serveDir(root);
  if (portFlag) { /* static server picks a free port; --port is accepted for callers that only need a URL */ }
  return { url: new URL(page, srv.url).href, close: srv.close };
}

function personasFrom(flags: Flags) {
  const only = typeof flags.personas === "string" ? flags.personas.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const dir = typeof flags["personas-dir"] === "string" ? flags["personas-dir"] : path.join(REPO_ROOT, "personas");
  return loadPersonas(dir, only);
}

function allowFrom(flags: Flags): string[] {
  const extra = typeof flags.allow === "string" ? flags.allow.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return ["127.0.0.1", "localhost", ...extra];
}

function redactFrom(flags: Flags): string[] {
  const cli = typeof flags.redact === "string" ? flags.redact.split(",") : [];
  const env = (process.env.FRL_REDACT ?? "").split(",");
  return [...env, ...cli].map((s) => s.trim()).filter(Boolean);
}

async function doRun(flags: Flags, gateMin?: number): Promise<number> {
  const target = flags._[0];
  if (!target) throw new Error("missing target");
  const opened = await targetUrl(target);
  const out = typeof flags.out === "string" ? flags.out : fs.mkdtempSync(path.join(os.tmpdir(), "frl-run-"));
  try {
    const rep = await run({
      url: opened.url,
      out,
      budget: typeof flags.budget === "string" ? Number(flags.budget) : 12,
      kind: (typeof flags.kind === "string" ? flags.kind : "auto") as "auto" | "form" | "dashboard",
      personas: personasFrom(flags),
      allow: allowFrom(flags),
      redact: redactFrom(flags),
      shots: !flags["no-shots"] && flags.shots !== "0",
    });
    const score = rep.verdict.kind === "scored" ? String(rep.verdict.score) : rep.verdict.kind === "unreachable" || rep.verdict.kind === "needs_backend" ? `${rep.verdict.kind}: ${rep.verdict.detail}` : rep.verdict.kind;
    console.log(`score: ${score}  (${rep.hotspots.length} hotspots)`);
    for (const h of rep.hotspots.slice(0, 8)) console.log(`  ${h.severity.padEnd(8)} ${h.kinds.join(", ")} -> ${h.control}`);
    if (gateMin != null) return gateCode(rep, gateMin);
    return 0;
  } finally {
    await opened.close?.();
  }
}

function readRuns(dir: string): { name: string; run: Run }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; run: Run }[] = [];
  for (const name of fs.readdirSync(dir)) {
    const runJson = path.join(dir, name, "run.json");
    const direct = path.join(dir, name);
    if (fs.existsSync(runJson)) out.push({ name, run: loadRun(path.join(dir, name)) });
    else if (name.endsWith(".json") && fs.statSync(direct).isFile()) {
      const data = JSON.parse(fs.readFileSync(direct, "utf8"));
      if (data && data.schema === 1) out.push({ name: name.replace(/\.json$/, ""), run: data as Run });
    }
  }
  const lone = path.join(dir, "run.json");
  if (fs.existsSync(lone)) out.push({ name: path.basename(dir), run: loadRun(dir) });
  return out;
}

async function serveDashboard(flags: Flags): Promise<number> {
  const dir = typeof flags.runs === "string" ? flags.runs : path.join(REPO_ROOT, "runs");
  const html = () => dashboardHtml(readRuns(dir));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html());
  });
  const port = typeof flags.port === "string" ? Number(flags.port) : 4173;
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  console.log(`dashboard http://127.0.0.1:${port}/`);
  await new Promise(() => undefined);
  return 0;
}

async function doSweep(flags: Flags): Promise<number> {
  const personas = personasFrom(flags);
  if (typeof flags.ports === "string") {
    const [a, b] = flags.ports.split("-").map(Number);
    const items: { name: string; url: string }[] = [];
    for (let p = a; p <= b; p++) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(400) });
        if (res.status) items.push({ name: `port-${p}`, url: `http://127.0.0.1:${p}/` });
      } catch { /* closed */ }
    }
    const board = sortBoard(await sweepUrls(items, personas));
    const out = typeof flags.out === "string" ? flags.out : "sweep.json";
    fs.writeFileSync(out, JSON.stringify(board, null, 2));
    for (const e of board) console.log(`${e.score ?? "—"}  ${e.name}  ${e.verdict}`);
    console.log(`${board.length} apps -> ${out}`);
    return 0;
  }
  throw new Error("frl sweep needs --ports start-end");
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = parse(rest);
  if (cmd === "run") return doRun(flags);
  if (cmd === "gate") {
    if (typeof flags.min !== "string") throw new Error("gate needs --min");
    return doRun(flags, Number(flags.min));
  }
  if (cmd === "diff") {
    const [a, b] = flags._;
    const diff = diffRuns(loadRun(a), loadRun(b));
    console.log(`score ${diff.scoreA} -> ${diff.scoreB}`);
    for (const h of diff.resolved) console.log(`  resolved ${h.id} ${h.control}`);
    for (const h of diff.added) console.log(`  added ${h.id} ${h.control}`);
    return 0;
  }
  if (cmd === "replay") {
    const gif = typeof flags.gif === "string" ? flags.gif : "demo.gif";
    await writeGif({ badDir: flags._[0], fixedDir: typeof flags.fixed === "string" ? flags.fixed : undefined, gif });
    console.log(gif);
    return 0;
  }
  if (cmd === "sweep") return doSweep(flags);
  if (cmd === "serve") return serveDashboard(flags);
  throw new Error("commands: run, diff, gate, replay, sweep, serve");
}

const invoked = process.argv[1] && /cli\.ts$/.test(process.argv[1]);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof RefuseHost) {
        console.error(err.message);
        process.exit(err.code);
      }
      if (err instanceof PrivacyError) {
        console.error(err.message);
        process.exit(err.code);
      }
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
