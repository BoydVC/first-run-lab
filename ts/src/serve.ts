import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./types.js";
import { loadRun } from "./engine.js";
import { renderHistory, renderLeaderboard, renderStatechart, type BoardRow, type DashRun } from "./report.js";

export interface ServeOpts {
  port?: number;
  runsDir: string;
  sweepFile?: string;
}

function label(run: Run): string {
  if (run.verdict.kind === "scored") return `${run.verdict.score} / 100 · ${run.hotspots.length} hotspots`;
  if (run.verdict.kind === "inconclusive") return "Inconclusive";
  return run.verdict.detail;
}

function history(dir: string): DashRun[] {
  if (!existsSync(dir)) return [];
  const rows: DashRun[] = [];
  for (const name of readdirSync(dir)) {
    const runJson = join(dir, name, "run.json");
    if (!existsSync(runJson)) continue;
    try {
      const run = loadRun(runJson);
      rows.push({
        id: run.id || name,
        url: run.url,
        startedAt: run.startedAt,
        label: label(run),
        href: existsSync(join(dir, name, "report.html")) ? `/runs/${encodeURIComponent(name)}/` : null,
      });
    } catch { /* skip unreadable */ }
  }
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function board(file?: string): BoardRow[] {
  if (!file || !existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, { score?: number | null; verdict?: string; hotspots?: { kinds?: string[] }[] }>;
  return Object.entries(data).map(([name, r]) => ({
    name,
    score: r.score ?? null,
    verdict: r.verdict || "",
    kinds: [...new Set((r.hotspots || []).flatMap((h) => h.kinds || []))],
  }));
}

function safeRunFile(root: string, id: string, file: string): string | null {
  if (id.includes("..") || file.includes("..")) return null;
  const path = join(root, id, file);
  if (!path.startsWith(join(root, id))) return null;
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

export function startDashboard(opts: ServeOpts): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const port = opts.port ?? 4310;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const send = (code: number, body: string, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname === "/" || url.pathname === "/index.html") return send(200, renderHistory(history(opts.runsDir)));
    if (url.pathname === "/leaderboard") return send(200, renderLeaderboard(board(opts.sweepFile)));
    if (url.pathname === "/statechart") return send(200, renderStatechart());
    const runPage = url.pathname.match(/^\/runs\/([^/]+)\/?$/);
    if (runPage) {
      const file = safeRunFile(opts.runsDir, decodeURIComponent(runPage[1]), "report.html");
      if (!file) return send(404, "not found");
      return send(200, readFileSync(file, "utf8"));
    }
    const asset = url.pathname.match(/^\/runs\/([^/]+)\/(.+)$/);
    if (asset) {
      const file = safeRunFile(opts.runsDir, decodeURIComponent(asset[1]), decodeURIComponent(asset[2]));
      if (!file) return send(404, "not found");
      const type = file.endsWith(".png") ? "image/png" : file.endsWith(".json") ? "application/json" : "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(readFileSync(file));
      return;
    }
    send(404, "not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const got = (server.address() as { port: number }).port;
      resolve({ server, port: got, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
