import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join as pathJoin, normalize } from "node:path";
import { findingCount, hotspotDetailCount, mergeFindings, verdictFor } from "./merge.js";
import { assertLocalUrl, detectKind, launchBrowser, runSession, type TargetRefusedError } from "./observe.js";
import { BUILTIN_PERSONAS } from "./personas.js";
import { assertClean, PrivacyError } from "./privacy.js";
import { preReport } from "./statechart.js";
import {
  isFindingKind,
  needsBackend,
  personaId,
  unreachable,
  type FindingKind,
  type PageKind,
  type Persona,
  type Run,
  type Session,
} from "./types.js";

export interface RunOptions {
  personas?: readonly Persona[];
  budget?: number;
  kind?: "auto" | PageKind;
  out?: string;
  allow?: readonly string[];
  redact?: readonly string[];
  screenshots?: boolean;
  browser?: Browser;
  /** When true, a privacy hit throws and nothing is written. Default true. */
  scan?: boolean;
}

export function defaultAllow(extra: readonly string[] = []): Set<string> {
  return new Set(["127.0.0.1", "localhost", ...extra]);
}

function newId(): string {
  return randomBytes(4).toString("hex");
}

function emptyRun(url: string, kind: PageKind, verdict: Run["verdict"]): Run {
  return {
    schema: 1,
    id: newId(),
    url,
    startedAt: new Date().toISOString(),
    kind,
    sessions: [],
    hotspots: [],
    verdict,
    blocked: [],
  };
}

export async function landingStatus(url: string): Promise<number | string> {
  try {
    const response = await fetch(url);
    return response.status;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 60) : "error";
  }
}

export async function runUrl(url: string, opts: RunOptions = {}): Promise<Run> {
  const allow = defaultAllow(opts.allow ?? []);
  assertLocalUrl(url, allow);
  const budget = opts.budget ?? 12;
  const redact = opts.redact ?? [];
  const personas = opts.personas ?? BUILTIN_PERSONAS;
  const requested = opts.kind ?? "auto";
  const status = await landingStatus(url);
  if (status !== 200) {
    const kind: PageKind = requested === "auto" ? "form" : requested;
    return emptyRun(url, kind, unreachable(`landing page returned ${status}`));
  }
  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? (await launchBrowser());
  const blocked: string[] = [];
  try {
    const kind: PageKind = requested === "auto" ? await detectKind(browser, url, allow) : requested;
    const settled = await Promise.all(
      personas.map((persona) =>
        runSession(browser, persona, url, {
          kind,
          budget,
          redact,
          allow,
          screenshots: opts.screenshots === true,
          outDir: opts.out ?? null,
          blocked,
        }),
      ),
    );
    const sessions: Session[] = settled.map(({ apiFail: _f, apiOk: _o, ...session }) => session);
    const fails = [...new Set(settled.flatMap((session) => session.apiFail))].sort();
    const oks = settled.some((session) => session.apiOk.length > 0);
    if (fails.length > 0 && oks) {
      const skimmer = sessions.find((session) => session.persona === personaId("skimmer")) ?? sessions[0];
      const template = BUILTIN_PERSONAS[0];
      if (skimmer && template) {
        const { brokenApi } = await import("./personas.js");
        const extra = brokenApi(
          { url, kind, controls: [], overflowPx: 0, redact, brokenApis: fails.map(parseApi) },
          { ...template, id: skimmer.persona },
        );
        skimmer.findings.push(...extra);
      }
    } else if (fails.length > 0) {
      return emptyRun(url, kind, needsBackend(fails.slice(0, 3).join(", ")));
    }
    const hotspots = mergeFindings(sessions);
    if (findingCount(sessions) !== hotspotDetailCount(hotspots)) {
      throw new Error("I6: merge dropped findings");
    }
    const verdict = verdictFor(sessions, hotspots);
    if (verdict.kind === "scored" && sessions.some((session) => preReport(session) === "crashed")) {
      throw new Error("refusing to score a run with a crashed session");
    }
    const run: Run = {
      schema: 1,
      id: newId(),
      url,
      startedAt: new Date().toISOString(),
      kind,
      sessions,
      hotspots,
      verdict,
      blocked: [...new Set(blocked)].sort(),
    };
    try {
      if (opts.scan !== false) assertClean(JSON.stringify(run));
      if (opts.out) writeRun(opts.out, run);
    } catch (error) {
      if (error instanceof PrivacyError && opts.out) rmSync(opts.out, { recursive: true, force: true });
      throw error;
    }
    return run;
  } finally {
    if (ownBrowser) await browser.close();
  }
}

function parseApi(line: string): { path: string; status: number } {
  const space = line.lastIndexOf(" ");
  return { path: line.slice(0, space), status: Number(line.slice(space + 1)) };
}

export function writeRun(dir: string, run: Run): void {
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(run, null, 1);
  assertClean(body);
  const tmp = join(dir, `.run.${process.pid}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(dir, "run.json"));
  const rows = run.hotspots
    .map(
      (hotspot) =>
        `<tr><td>${hotspot.id}</td><td class="${hotspot.severity}">${hotspot.severity}</td><td>${hotspot.kinds.join(", ")}</td><td>${escapeHtml(hotspot.control)}</td><td>${hotspot.personas.join(", ")}</td><td>${hotspot.details.map(escapeHtml).join("<br>")}</td></tr>`,
    )
    .join("");
  const headline =
    run.verdict.kind === "scored" ? `score ${run.verdict.score}/100` : `INCONCLUSIVE (${run.verdict.kind})`;
  const html = `<!doctype html><meta charset="utf-8"><title>First-Run Lab</title><style>body{font-family:sans-serif}.blocker{color:#b00;font-weight:bold}.major{color:#c60}td{padding:4px;border-bottom:1px solid #ddd}</style><h1>First-Run Lab — ${headline}</h1><p>${run.hotspots.length} hotspots from ${run.sessions.length} personas on ${escapeHtml(run.url)} (${run.kind})</p><table>${rows}</table>`;
  assertClean(html);
  writeFileSync(join(dir, "report.html"), html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

export function personaFromJson(raw: unknown): Persona {
  if (typeof raw !== "object" || raw === null) throw new Error("persona json is not an object");
  const row = raw as Record<string, unknown>;
  const viewport = row.viewport;
  if (typeof viewport !== "object" || viewport === null) throw new Error("persona viewport missing");
  const box = viewport as Record<string, unknown>;
  const checksRaw = row.checks;
  if (!Array.isArray(checksRaw)) throw new Error("persona checks missing");
  const checks: FindingKind[] = [];
  for (const item of checksRaw) {
    if (typeof item !== "string" || !isFindingKind(item)) throw new Error(`unknown check: ${String(item)}`);
    checks.push(item);
  }
  return {
    id: personaId(String(row.id ?? "")),
    label: String(row.label ?? row.id ?? ""),
    viewport: { w: Number(box.w), h: Number(box.h) },
    touch: row.touch === true,
    patienceMs: Number(row.patienceMs),
    goal: String(row.goal ?? ""),
    checks,
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export function serveStatic(root: string, port = 0): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      const rel = pathname === "/" ? "" : pathname.replace(/^\/+/, "");
      const full = normalize(pathJoin(root, rel));
      if (!full.startsWith(normalize(root))) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const { stat } = await import("node:fs/promises");
      let info;
      try {
        info = await stat(full);
      } catch {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      if (info.isDirectory()) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>index</title>");
        return;
      }
      const body = await readFile(full);
      const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end("error");
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}/`,
        port: bound,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export type { TargetRefusedError };
