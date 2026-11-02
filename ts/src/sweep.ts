/**
 * Sweep helpers: shared-code groups (Jaccard), offline start hints, template builds.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { connect } from "node:net";


export function readHints(path: string | undefined): Record<string, string> {
  if (!path && process.env.FRL_HINTS) path = process.env.FRL_HINTS;
  if (!path || !existsSync(path)) return {};
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number") out[key] = String(value);
  }
  return out;
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, ext, acc);
    else if (name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

export function appDir(root: string, repo: string): string {
  for (const folder of ["web", "static", "public", "."]) {
    const path = join(root, repo, folder);
    if (existsSync(join(path, "index.html"))) return path;
  }
  return join(root, repo);
}

export function codeLines(web: string): Set<string> {
  const chunks: string[] = [];
  for (const file of [...walk(web, ".css"), ...walk(web, ".js")].sort()) {
    if (file.includes("vendor") || file.includes(".min.")) continue;
    chunks.push(readFileSync(file, "utf8"));
  }
  if (existsSync(web)) {
    for (const name of readdirSync(web)) {
      if (!name.endsWith(".html")) continue;
      const html = readFileSync(join(web, name), "utf8");
      const blocks = html.match(/<(?:style|script)[^>]*>([\s\S]*?)<\/(?:style|script)>/g) ?? [];
      for (const block of blocks) {
        const inner = block.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>$/, "");
        chunks.push(inner);
      }
    }
  }
  const lines = new Set<string>();
  for (const chunk of chunks) {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 3) lines.add(trimmed);
    }
  }
  return lines;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function codeGroups(root: string, repos: readonly string[], thresh = 0.6, minLines = 5): Record<string, string[]> {
  const lines = new Map<string, Set<string>>();
  for (const repo of repos) {
    const set = codeLines(appDir(root, repo));
    if (set.size >= minLines) lines.set(repo, set);
  }
  const parent = new Map<string, string>();
  for (const repo of lines.keys()) parent.set(repo, repo);
  const find = (name: string): string => {
    let cursor = name;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      if (!next) break;
      cursor = next;
    }
    return cursor;
  };
  const names = [...lines.keys()].sort();
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i];
      const b = names[j];
      if (!a || !b) continue;
      const la = lines.get(a);
      const lb = lines.get(b);
      if (!la || !lb) continue;
      if (jaccard(la, lb) >= thresh) parent.set(find(b), find(a));
    }
  }
  const grouped = new Map<string, string[]>();
  for (const repo of names) {
    const lead = find(repo);
    const list = grouped.get(lead) ?? [];
    list.push(repo);
    grouped.set(lead, list);
  }
  const out: Record<string, string[]> = {};
  for (const [lead, members] of grouped) {
    if (members.length < 2) continue;
    const leadLines = lines.get(lead);
    const body = [...(leadLines ?? [])].sort().join("");
    const key = createHash("sha1").update(body).digest("hex").slice(0, 10);
    out[key] = members;
  }
  return out;
}

export function groupReport<T extends Record<string, unknown>>(res: Record<string, T>, groups: Record<string, string[]>): Record<string, T> {
  for (const [key, members] of Object.entries(groups)) {
    const lead = [...members].sort()[0];
    for (const member of members) {
      const row: Record<string, unknown> | undefined = res[member];
      if (!row) continue;
      row.group = key;
      if (member !== lead) row.dup_of = lead;
    }
  }
  return res;
}

export function startHint(repoDir: string, hints: Record<string, string> = readHints(undefined)): string | null {
  for (const name of ["README.md", "readme.md", "README"]) {
    const path = join(repoDir, name);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^\s*(?:<!--\s*)?frl-start:\s*(.+?)\s*(?:-->)?\s*$/im);
    if (match?.[1]) return match[1].trim();
  }
  const base = basename(repoDir);
  if (hints[base]) return hints[base] ?? null;
  for (const file of ["app.py", "server.py", "main.py"]) {
    if (existsSync(join(repoDir, file))) return `python3 ${file}`;
  }
  return null;
}

export function buildHint(repoDir: string, hints: Record<string, string> = readHints(undefined)): string | null {
  for (const name of ["README.md", "readme.md", "README"]) {
    const path = join(repoDir, name);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^\s*(?:<!--\s*)?frl-build:\s*(.+?)\s*(?:-->)?\s*$/im);
    if (match?.[1]) return match[1].trim();
  }
  const key = `${basename(repoDir)}:build`;
  return hints[key] ?? null;
}

function runProcess(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

export async function prepareStatic(root: string, repo: string): Promise<{ dir: string; page: string; how: string }> {
  const web = appDir(root, repo);
  const indexPath = join(web, "index.html");
  const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (!html.includes("/*__")) return { dir: web, page: "index.html", how: "static" };
  const repoDir = join(root, repo);
  const build = join(repoDir, "build.py");
  if (existsSync(build)) {
    try {
      await runProcess("unshare", ["-rn", "python3", "build.py"], repoDir, process.env);
      const dist = join(repoDir, "dist");
      if (existsSync(dist)) {
        const htmls = (await readdir(dist)).filter((name) => name.endsWith(".html"));
        const built: string[] = [];
        for (const name of htmls) {
          const text = await readFile(join(dist, name), "utf8");
          if (!text.includes("/*__")) built.push(name);
        }
        const newest = built.sort()[built.length - 1];
        if (newest) return { dir: dist, page: newest, how: "build.py" };
      }
    } catch {
      /* fall through to the inliner */
    }
  }
  const out = join(repoDir, "_frl_built");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const name of await readdir(web)) {
    const from = join(web, name);
    if ((await stat(from)).isFile()) await copyFile(from, join(out, name));
  }
  const source = await readFile(indexPath, "utf8");
  const stripped = source.replace(/\/\*__DATA__\*\/[\s\S]*?\/\*__\/DATA__\*\//g, "null");
  const inlined = stripped.replace(/\/\*__([A-Z]+)__\*\//g, (_all, token: string) => {
    const name = token.toLowerCase();
    const file = name === "css" ? "app.css" : name === "app" || name === "js" ? "app.js" : `${name}.js`;
    const path = join(web, file);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8").replaceAll("</script", "<\\/script");
  });
  await writeFile(join(out, "index.html"), inlined);
  return { dir: out, page: "index.html", how: "inline" };
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error("start timed out"));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

export async function launchApp(repoDir: string, port: number, hints: Record<string, string> = {}): Promise<{ url: string; stop: () => void }> {
  const hintPort = hints[`${basename(repoDir)}:port`];
  const bound = hintPort ? Number(hintPort) : port;
  const build = buildHint(repoDir, hints);
  if (build) {
    await runProcess("unshare", ["-rn", "sh", "-c", build], repoDir, { ...process.env, DEMO: "1", FRL_DEMO: "1" });
  }
  const command = startHint(repoDir, hints);
  if (!command) throw new Error(`no start hint for ${repoDir}`);
  const env = { ...process.env, PORT: String(bound), HOST: "127.0.0.1", DEMO: "1", FRL_DEMO: "1", NO_NETWORK: "1" };
  const child = spawn("sh", ["-c", command.replaceAll("{port}", String(bound))], {
    cwd: repoDir,
    env,
    stdio: "ignore",
    detached: true,
  });
  try {
    await waitForPort(bound, 20_000);
  } catch (error) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    throw error;
  }
  return {
    url: `http://127.0.0.1:${bound}/`,
    stop: () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      }
    },
  };
}

export interface SweepRow {
  name: string;
  url: string;
  score: number | null;
  verdict: string;
  kind: string;
}

export function leaderboard<T extends { score: number | null; verdict: string; name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const aScored = a.verdict === "scored" || a.score !== null;
    const bScored = b.verdict === "scored" || b.score !== null;
    if (aScored !== bScored) return aScored ? -1 : 1;
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
