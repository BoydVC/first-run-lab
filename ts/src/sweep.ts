import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Run } from "./types.js";
import { executeRun } from "./engine.js";

const TPL = /\/\*__([A-Z]+)__\*\//g;

export function hintsFromEnv(): Record<string, string | number> {
  if (!process.env.FRL_HINTS || !existsSync(process.env.FRL_HINTS)) return {};
  return JSON.parse(readFileSync(process.env.FRL_HINTS, "utf8"));
}

function readme(dir: string): string {
  for (const n of ["README.md", "readme.md", "README"]) {
    const p = join(dir, n);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "";
}

export function startHint(repoDir: string, hints = hintsFromEnv()): string | null {
  const m = readme(repoDir).match(/^\s*(?:<!--\s*)?frl-start:\s*(.+?)\s*(?:-->)?\s*$/im);
  if (m) return m[1];
  const name = basename(resolve(repoDir));
  if (hints[name]) return String(hints[name]);
  for (const f of ["app.py", "server.py", "main.py"]) {
    if (existsSync(join(repoDir, f))) return `python3 ${f}`;
  }
  return null;
}

export function buildHint(repoDir: string, hints = hintsFromEnv()): string | null {
  const m = readme(repoDir).match(/^\s*(?:<!--\s*)?frl-build:\s*(.+?)\s*(?:-->)?\s*$/im);
  if (m) return m[1];
  const name = basename(resolve(repoDir));
  const v = hints[`${name}:build`];
  return v ? String(v) : null;
}

export function appDir(root: string, repo: string): string {
  for (const d of ["web", "static", "public", "."]) {
    const p = join(root, repo, d);
    if (existsSync(join(p, "index.html"))) return p;
  }
  return join(root, repo);
}

function codeLinesOf(web: string): Set<string> {
  const lines = new Set<string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "vendor" || name === "node_modules") continue;
        walk(p);
      } else if (/\.(css|js)$/.test(name) && !name.includes(".min.") && !p.includes("vendor")) {
        for (const l of readFileSync(p, "utf8").split(/\r?\n/)) if (l.trim().length > 3) lines.add(l.trim());
      }
    }
  };
  walk(web);
  if (existsSync(web)) {
    for (const name of readdirSync(web)) {
      if (!name.endsWith(".html")) continue;
      const html = readFileSync(join(web, name), "utf8");
      const blocks = html.match(/<(?:style|script)[^>]*>([\s\S]*?)<\/(?:style|script)>/g) || [];
      for (const b of blocks) for (const l of b.split(/\r?\n/)) if (l.trim().length > 3) lines.add(l.trim());
    }
  }
  return lines;
}

/** Jaccard overlap of CSS/JS lines. Apps with fewer than 5 lines never group. Threshold 0.6. */
export function codeGroups(root: string, repos: string[], thresh = 0.6, minLines = 5): Record<string, string[]> {
  const L = new Map<string, Set<string>>();
  for (const r of repos) {
    const lines = codeLinesOf(appDir(root, r));
    if (lines.size >= minLines) L.set(r, lines);
  }
  const parent = new Map<string, string>([...L.keys()].map((r) => [r, r]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  const rs = [...L.keys()].sort();
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = L.get(rs[i])!;
      const b = L.get(rs[j])!;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const union = a.size + b.size - inter;
      if (union && inter / union >= thresh) parent.set(find(rs[j]), find(rs[i]));
    }
  }
  const groups = new Map<string, string[]>();
  for (const r of rs) {
    const f = find(r);
    groups.set(f, [...(groups.get(f) || []), r]);
  }
  const out: Record<string, string[]> = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const lead = [...members].sort()[0];
    const key = createHash("sha1").update([...L.get(lead)!].sort().join("")).digest("hex").slice(0, 10);
    out[key] = members;
  }
  return out;
}

export function groupReport<T extends Record<string, Record<string, unknown>>>(res: T, groups: Record<string, string[]>): T {
  for (const [k, members] of Object.entries(groups)) {
    const lead = [...members].sort()[0];
    for (const m of members) {
      if (res[m]) {
        res[m].group = k;
        if (m !== lead) res[m].dup_of = lead;
      }
    }
  }
  return res;
}

export function prepareStatic(root: string, repo: string): { dir: string; page: string; how: string } {
  const web = appDir(root, repo);
  const idx = join(web, "index.html");
  const raw = existsSync(idx) ? readFileSync(idx, "utf8") : "";
  if (!raw.includes("/*__")) return { dir: web, page: "index.html", how: "static" };
  const rd = join(root, repo);
  const build = join(rd, "build.py");
  if (existsSync(build)) {
    spawnSync("unshare", ["-rn", "python3", "build.py"], { cwd: rd, timeout: 120000, stdio: "ignore" });
    const dist = join(rd, "dist");
    if (existsSync(dist)) {
      const hs = readdirSync(dist)
        .filter((n) => n.endsWith(".html"))
        .map((n) => join(dist, n))
        .filter((p) => !readFileSync(p, "utf8").includes("/*__"))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
      if (hs.length) return { dir: dist, page: basename(hs[hs.length - 1]), how: "build.py" };
    }
  }
  const out = join(rd, "_frl_built");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const sub = (src: string) =>
    src.replace(TPL, (_m, n: string) => {
      const name = n.toLowerCase();
      const file = name === "css" ? "app.css" : name === "app" || name === "js" ? "app.js" : `${name}.js`;
      const p = join(web, file);
      return existsSync(p) ? readFileSync(p, "utf8").replaceAll("</script", "<\\/script") : "";
    });
  const stripped = raw.replace(/\/\*__DATA__\*\/[\s\S]*?\/\*__\/DATA__\*\//, "null");
  writeFileSync(join(out, "index.html"), sub(stripped));
  return { dir: out, page: "index.html", how: "inline" };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export async function launch<T>(repoDir: string, port: number, fn: (url: string) => Promise<T>, timeoutMs = 20000): Promise<T> {
  const hints = hintsFromEnv();
  const name = basename(resolve(repoDir));
  const fixed = Number(hints[`${name}:port`] || port);
  const b = buildHint(repoDir, hints);
  if (b) {
    spawnSync("unshare", ["-rn", "sh", "-c", b], {
      cwd: repoDir,
      timeout: 120000,
      stdio: "ignore",
      env: { ...process.env, DEMO: "1", FRL_DEMO: "1" },
    });
  }
  const cmd = (startHint(repoDir, hints) || "python3 server.py").replaceAll("{port}", String(fixed));
  const child = spawn(cmd, {
    shell: true,
    cwd: repoDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(fixed), HOST: "127.0.0.1", DEMO: "1", FRL_DEMO: "1", NO_NETWORK: "1" },
  });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await portOpen(fixed)) break;
      if (child.exitCode != null) throw new Error(`start failed: exit ${child.exitCode}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!(await portOpen(fixed))) throw new Error("start timed out");
    return await fn(`http://127.0.0.1:${fixed}/`);
  } finally {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

export async function sweepPorts(
  ports: number[],
  opts: { browser?: import("playwright").Browser; out?: string } = {},
): Promise<Record<string, { score: number | null; verdict: string; hotspots: Run["hotspots"] }>> {
  const res: Record<string, { score: number | null; verdict: string; hotspots: Run["hotspots"] }> = {};
  for (const port of ports) {
    if (!(await portOpen(port))) continue;
    const url = `http://127.0.0.1:${port}/`;
    const out = join(tmpdir(), `frl-sweep-${port}`);
    const run = await executeRun({ url, out, browser: opts.browser, evidence: false, kind: "auto" });
    res[String(port)] = {
      score: run.verdict.kind === "scored" ? run.verdict.score : null,
      verdict: run.verdict.kind === "scored" ? "scored" : run.verdict.kind === "inconclusive" ? "inconclusive" : `${run.verdict.kind}: ${run.verdict.detail}`,
      hotspots: run.hotspots,
    };
  }
  if (opts.out) writeFileSync(opts.out, JSON.stringify(res, null, 2));
  return res;
}

export function staticServer(root: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes("..")) { res.writeHead(400); res.end("bad path"); return; }
    let file = join(root, rel);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200);
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
