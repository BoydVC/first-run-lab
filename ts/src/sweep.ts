import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { run as frlRun } from "./engine.ts";
import type { Persona, Run } from "./types.ts";

const execFileAsync = promisify(execFile);
export function appDir(root: string, repo: string): string {
  for (const d of ["web", "static", "public", "."]) {
    const p = path.join(root, repo, d);
    if (fs.existsSync(path.join(p, "index.html"))) return p;
  }
  return path.join(root, repo);
}

export function startHint(repoDir: string, hints: Record<string, string> = {}): string | null {
  for (const n of ["README.md", "readme.md", "README"]) {
    const p = path.join(repoDir, n);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^\s*(?:<!--\s*)?frl-start:\s*(.+?)\s*(?:-->)?\s*$/im);
    if (m) return m[1].trim();
  }
  const base = path.basename(path.resolve(repoDir));
  if (hints[base]) return hints[base];
  for (const f of ["app.py", "server.py", "main.py"]) {
    if (fs.existsSync(path.join(repoDir, f))) return `python3 ${f}`;
  }
  return null;
}

export function buildHint(repoDir: string, hints: Record<string, string> = {}): string | null {
  for (const n of ["README.md", "readme.md", "README"]) {
    const p = path.join(repoDir, n);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^\s*(?:<!--\s*)?frl-build:\s*(.+?)\s*(?:-->)?\s*$/im);
    if (m) return m[1].trim();
  }
  const base = path.basename(path.resolve(repoDir));
  return hints[`${base}:build`] ?? null;
}

export async function launch(repoDir: string, port: number, hints: Record<string, string> = {}, timeoutMs = 20000): Promise<{ url: string; stop(): void }> {
  const fixed = Number(hints[`${path.basename(path.resolve(repoDir))}:port`] ?? port);
  const build = buildHint(repoDir, hints);
  if (build) {
    await execFileAsync("unshare", ["-rn", "sh", "-c", build], {
      cwd: repoDir,
      timeout: 120000,
      env: { ...process.env, DEMO: "1", FRL_DEMO: "1" },
    });
  }
  const cmd = (startHint(repoDir, hints) ?? "").replaceAll("{port}", String(fixed));
  if (!cmd) throw new Error(`no start hint for ${repoDir}`);
  const child = spawn(cmd, {
    shell: true,
    cwd: repoDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(fixed), HOST: "127.0.0.1", DEMO: "1", FRL_DEMO: "1", NO_NETWORK: "1" },
  });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${fixed}/`);
      if (res.status) {
        return {
          url: `http://127.0.0.1:${fixed}/`,
          stop: () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ } },
        };
      }
    } catch { /* not up yet */ }
    if (child.exitCode != null) throw new Error(`start failed: exit ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  try { process.kill(-child.pid!, "SIGTERM"); } catch { /* ignore */ }
  throw new Error("start timed out");
}

/** Run the app's server inside a loopback-only network namespace and return the landing text. */
export async function isolatedLanding(repoDir: string, hints: Record<string, string> = {}): Promise<string> {
  const base = path.basename(path.resolve(repoDir));
  const port = Number(hints[`${base}:port`] ?? 4311);
  const cmd = (startHint(repoDir, hints) ?? "").replaceAll("{port}", String(port));
  if (!cmd) throw new Error("no start hint");
  const script = `ip link set lo up && (${cmd}) >/tmp/frl-iso.log 2>&1 & for i in $(seq 1 40); do if curl -sf http://127.0.0.1:${port}/; then exit 0; fi; sleep 0.25; done; exit 1`;
  const { stdout } = await execFileAsync("unshare", ["-rn", "sh", "-c", script], { cwd: repoDir, timeout: 30000 });
  return stdout;
}

function codeLines(web: string): Set<string> {
  let txt = "";
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(css|js)$/.test(name) && !name.includes(".min.") && !p.includes(`${path.sep}vendor${path.sep}`)) txt += fs.readFileSync(p, "utf8") + "\n";
    }
  };
  walk(web);
  for (const name of fs.existsSync(web) ? fs.readdirSync(web) : []) {
    if (!name.endsWith(".html")) continue;
    const html = fs.readFileSync(path.join(web, name), "utf8");
    txt += [...html.matchAll(/<(?:style|script)[^>]*>([\s\S]*?)<\/(?:style|script)>/g)].map((m) => m[1]).join("\n");
  }
  return new Set(txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3));
}

export function codeGroups(root: string, repos: string[], thresh = 0.6, minLines = 5): Record<string, string[]> {
  const lines: Record<string, Set<string>> = {};
  for (const r of repos) {
    const set = codeLines(appDir(root, r));
    if (set.size >= minLines) lines[r] = set;
  }
  const parent: Record<string, string> = {};
  for (const r of Object.keys(lines)) parent[r] = r;
  const find = (x: string): string => (parent[x] === x ? x : find(parent[x]));
  const rs = Object.keys(lines).sort();
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = lines[rs[i]];
      const b = lines[rs[j]];
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const union = a.size + b.size - inter;
      if (union && inter / union >= thresh) parent[find(rs[j])] = find(rs[i]);
    }
  }
  const groups: Record<string, string[]> = {};
  for (const r of rs) {
    const lead = find(r);
    (groups[lead] ??= []).push(r);
  }
  const out: Record<string, string[]> = {};
  for (const members of Object.values(groups)) {
    if (members.length < 2) continue;
    const lead = [...members].sort()[0];
    const key = createHash("sha1").update([...lines[lead]].sort().join("")).digest("hex").slice(0, 10);
    out[key] = members;
  }
  return out;
}

export function groupReport<T extends Record<string, { group?: string; dup_of?: string }>>(res: T, groups: Record<string, string[]>): T {
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
  const idx = path.join(web, "index.html");
  const rd = path.join(root, repo);
  const raw = fs.existsSync(idx) ? fs.readFileSync(idx, "utf8") : "";
  if (!raw.includes("/*__")) return { dir: web, page: "index.html", how: "static" };
  const build = path.join(rd, "build.py");
  if (fs.existsSync(build)) {
    try {
      execFileSyncSafe(rd);
      const dist = path.join(rd, "dist");
      if (fs.existsSync(dist)) {
        const hs = fs.readdirSync(dist).filter((f) => f.endsWith(".html"))
          .map((f) => path.join(dist, f))
          .filter((f) => !fs.readFileSync(f, "utf8").includes("/*__"))
          .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
        if (hs.length) return { dir: dist, page: path.basename(hs.at(-1)!), how: "build.py" };
      }
    } catch { /* fall through to the inliner */ }
  }
  const out = path.join(rd, "_frl_built");
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(web, out, { recursive: true });
  const sub = (src: string) => src.replace(/\/\*__([A-Z]+)__\*\//g, (_m, n: string) => {
    const file = ({ css: "app.css", app: "app.js", js: "app.js" } as Record<string, string>)[n.toLowerCase()] ?? `${n.toLowerCase()}.js`;
    const p = path.join(web, file);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").replaceAll("</script", "<\\/script") : "";
  });
  const stripped = raw.replace(/\/\*__DATA__\*\/[\s\S]*?\/\*__\/DATA__\*\//g, "null");
  fs.writeFileSync(path.join(out, "index.html"), sub(stripped));
  return { dir: out, page: "index.html", how: "inline" };
}

function execFileSyncSafe(rd: string) {
  execFileSync("unshare", ["-rn", "python3", "build.py"], { cwd: rd, stdio: "ignore", timeout: 120000 });
}

export interface BoardEntry {
  name: string;
  url: string;
  score: number | null;
  verdict: string;
  hotspots: number;
}

export async function sweepUrls(
  items: { name: string; url: string }[],
  personas: Persona[],
  browser?: Parameters<typeof frlRun>[0]["browser"],
  kind: "auto" | "form" | "dashboard" = "auto",
): Promise<BoardEntry[]> {
  const entries: BoardEntry[] = [];
  for (const item of items) {
    const out = fs.mkdtempSync(path.join("/tmp", "frl-sweep-"));
    try {
      const rep = await frlRun({ url: item.url, out, personas, kind, shots: false, browser });
      entries.push({
        name: item.name,
        url: item.url,
        score: rep.verdict.kind === "scored" ? rep.verdict.score : null,
        verdict: rep.verdict.kind === "scored" ? "scored" : rep.verdict.kind === "inconclusive" ? "inconclusive" : `${rep.verdict.kind}: ${rep.verdict.detail}`,
        hotspots: rep.hotspots.length,
      });
    } catch (e) {
      entries.push({ name: item.name, url: item.url, score: null, verdict: `aborted: ${String(e).slice(0, 120)}`, hotspots: 0 });
    }
  }
  return sortBoard(entries);
}

export function sortBoard(entries: BoardEntry[]): BoardEntry[] {
  return [...entries].sort((a, b) => {
    if (a.score == null && b.score == null) return a.name.localeCompare(b.name);
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score || a.name.localeCompare(b.name);
  });
}

export type { Run };
