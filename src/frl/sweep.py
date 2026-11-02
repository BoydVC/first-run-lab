"""Sweep: run First-Run Lab against each app under a root; one port per app.
O3 groups apps that share CSS/JS; O4 launches Python-backed apps from a README `frl-start:` hint with demo data."""
import json, os, sys, re, glob, hashlib, socket, subprocess, time, contextlib
from . import firstrun as fr

def code_hash(web):
    h = hashlib.sha1()
    for f in sorted(glob.glob(os.path.join(web, "**", "*.css"), recursive=True) + glob.glob(os.path.join(web, "**", "*.js"), recursive=True)):
        h.update(open(f, "rb").read())
    for f in glob.glob(os.path.join(web, "*.html")):  # inline <style>/<script> too
        h.update("".join(re.findall(r"<(?:style|script)[^>]*>(.*?)</(?:style|script)>", open(f, errors="ignore").read(), re.S)).encode())
    return h.hexdigest()[:10]
def app_dir(root, repo):
    for d in ("web", "static", "public", "."):
        p = os.path.join(root, repo, d)
        if os.path.isfile(os.path.join(p, "index.html")): return p
    return os.path.join(root, repo)
TPL = re.compile(r"/\*__([A-Z]+)__\*/")
def prepare_static(root, repo):
    """Return (dir, page, how). Template apps (web/index.html with /*__CSS__*/ etc.) are built first:
    the repo's build.py offline (unshare -rn) -> newest dist/*.html; else a generic inliner. Never served raw."""
    web = app_dir(root, repo); idx = os.path.join(web, "index.html"); rd = os.path.join(root, repo)
    if not TPL.search(open(idx, errors="ignore").read()): return web, "index.html", "static"
    b = os.path.join(rd, "build.py")
    if os.path.isfile(b):
        try:
            subprocess.run(["unshare", "-rn", "python3", "build.py"], cwd=rd, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            hs = sorted(glob.glob(os.path.join(rd, "dist", "*.html")), key=os.path.getmtime)
            hs = [h for h in hs if not TPL.search(open(h, errors="ignore").read())]
            if hs: return os.path.join(rd, "dist"), os.path.basename(hs[-1]), "build.py"
        except Exception: pass
    import shutil
    out = os.path.join(rd, "_frl_built"); shutil.rmtree(out, ignore_errors=True); shutil.copytree(web, out)
    def sub(m):
        n = m.group(1).lower(); f = {"css": "app.css", "app": "app.js", "js": "app.js"}.get(n, n + ".js")
        p = os.path.join(web, f); return open(p, errors="ignore").read().replace("</script", "<\\/script") if os.path.isfile(p) else ""
    h = re.sub(r"/\*__DATA__\*/.*?/\*__/DATA__\*/", "null", open(idx, errors="ignore").read(), flags=re.S)
    open(os.path.join(out, "index.html"), "w").write(TPL.sub(sub, h)); return out, "index.html", "inline"
def code_lines(web):
    """Non-trivial CSS/JS lines (files + inline blocks), for near-duplicate detection."""
    txt = ""
    for f in sorted(glob.glob(os.path.join(web, "**", "*.css"), recursive=True) + glob.glob(os.path.join(web, "**", "*.js"), recursive=True)):
        if "vendor" in f or ".min." in f: continue
        txt += open(f, errors="ignore").read() + "\n"
    for f in glob.glob(os.path.join(web, "*.html")):
        txt += "\n".join(re.findall(r"<(?:style|script)[^>]*>(.*?)</(?:style|script)>", open(f, errors="ignore").read(), re.S))
    return {l.strip() for l in txt.splitlines() if len(l.strip()) > 3}
def code_groups(root, repos, thresh=0.6, min_lines=5):
    """Group apps whose CSS+JS line sets overlap (Jaccard >= thresh). Apps with no real code never group. Key = hash of the lead's code."""
    L = {r: code_lines(app_dir(root, r)) for r in repos}; L = {r: v for r, v in L.items() if len(v) >= min_lines}
    parent = {r: r for r in L}
    def find(x):
        while parent[x] != x: x = parent[x]
        return x
    rs = sorted(L)
    for i, a in enumerate(rs):
        for b in rs[i + 1:]:
            if len(L[a] & L[b]) / len(L[a] | L[b]) >= thresh: parent[find(b)] = find(a)
    g = {}
    for r in rs: g.setdefault(find(r), []).append(r)
    return {hashlib.sha1("".join(sorted(L[k])).encode()).hexdigest()[:10]: v for k, v in g.items() if len(v) > 1}
def group_report(res, groups):
    for k, members in groups.items():
        lead = sorted(members)[0]
        for m in members:
            if m in res:
                res[m]["group"] = k
                if m != lead: res[m]["dup_of"] = lead
    return res

HINTS = json.load(open(os.environ["FRL_HINTS"])) if os.environ.get("FRL_HINTS") else {}  # optional JSON of start/build hints
def start_hint(repo_dir):
    """README `frl-start:` line wins; else a local override in sweep/start-hints.json (we never write to repos); else app.py/server.py guess."""
    for n in ("README.md", "readme.md", "README"):
        p = os.path.join(repo_dir, n)
        if os.path.isfile(p):
            m = re.search(r"^\s*(?:<!--\s*)?frl-start:\s*(.+?)\s*(?:-->)?\s*$", open(p, errors="ignore").read(), re.M | re.I)
            if m: return m.group(1)
    if os.path.basename(os.path.normpath(repo_dir)) in HINTS: return HINTS[os.path.basename(os.path.normpath(repo_dir))]
    # fallback guess for Flask/FastAPI-style apps that read PORT/DEMO env vars
    for f in ("app.py", "server.py", "main.py"):
        if os.path.isfile(os.path.join(repo_dir, f)): return f"python3 {f}"
    return None
BUILD_HINTS = {k[:-6]: v for k, v in HINTS.items() if k.endswith(":build")}
def build_hint(repo_dir):
    for n in ("README.md", "readme.md", "README"):
        p = os.path.join(repo_dir, n)
        if os.path.isfile(p):
            m = re.search(r"^\s*(?:<!--\s*)?frl-build:\s*(.+?)\s*(?:-->)?\s*$", open(p, errors="ignore").read(), re.M | re.I)
            if m: return m.group(1)
    return BUILD_HINTS.get(os.path.basename(os.path.normpath(repo_dir)))
@contextlib.contextmanager
def launch(repo_dir, port, timeout=20):
    port = HINTS.get(os.path.basename(os.path.normpath(repo_dir)) + ":port", port)
    b = build_hint(repo_dir)
    if b:  # build with NO network (own user+net namespace) so demo data is whatever ships in the repo
        subprocess.run(["unshare", "-rn", "sh", "-c", b], cwd=repo_dir, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, DEMO="1", FRL_DEMO="1"))
    cmd = start_hint(repo_dir).format(port=port)
    env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", DEMO="1", FRL_DEMO="1", NO_NETWORK="1")
    p = subprocess.Popen(cmd, shell=True, cwd=repo_dir, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        t0 = time.time()
        while time.time() - t0 < timeout:
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0: break
            if p.poll() is not None: raise RuntimeError(f"start failed: exit {p.returncode}")
            time.sleep(0.3)
        else: raise RuntimeError("start timed out")
        yield f"http://127.0.0.1:{port}/"
    finally:
        try: os.killpg(p.pid, 15)
        except Exception: pass

def run_all(root, base_port=8800, py=()):
    res, repos = {}, sorted(r for r in os.listdir(root) if not r.startswith("_"))
    for n, repo in enumerate(repos):
        port = base_port + n; out = os.path.join(root, "_out", repo)
        try:
            if repo in py:
                with launch(os.path.join(root, repo), port) as url: r = fr.main(url, out, kind="auto"); r["backend"] = "python"
            else:
                if not os.path.isfile(os.path.join(app_dir(root, repo), "index.html")): continue
                web, pg, how = prepare_static(root, repo)
                srv = fr.serve(web, port)
                try: r = fr.main(f"http://127.0.0.1:{port}/{pg}", out, kind="auto"); r["backend"] = "static" if how == "static" else f"static ({how})"
                finally: srv.shutdown()
            res[repo] = {"score": r["score"], "kind": r["kind"], "backend": r.get("backend", "static"), "verdict": r["verdict"], "hotspots": r["hotspots"], "finals": [(s["persona"], s["final"], s["log"][-2]["why"]) for s in r["sessions"]]}
        except (SystemExit, Exception) as e: res[repo] = {"score": None, "verdict": f"aborted: {str(e)[:120]}", "hotspots": [], "finals": []}
        print(repo, res[repo]["score"], len(res[repo]["hotspots"]), flush=True)
    return group_report(res, code_groups(root, [r for r in res if res[r]["score"] is not None]))
def entry(r):
    return {"score": r["score"], "kind": r.get("kind"), "backend": r.get("backend", "static"), "verdict": r["verdict"], "hotspots": r["hotspots"],
            "finals": [(x["persona"], x["final"], x["log"][-2]["why"]) for x in r.get("sessions", [])], "landing_text": r.get("landing_text", "")}
def one(root, repo, port=8899):
    """Score one backend app. Meant to run INSIDE a private net namespace (see run_isolated)."""
    import urllib.request, html as H
    with launch(os.path.join(root, repo), port) as url:
        url = url.replace(str(port), str(HINTS.get(repo + ":port", port)))
        try: txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", H.unescape(urllib.request.urlopen(url, timeout=10).read().decode(errors="ignore")))).strip()[:80]
        except Exception as e: txt = f"[{e}]"[:80]
        r = fr.main(url, os.path.join(root, "_out", repo), kind="auto"); r["backend"] = "python (netns)"; r["landing_text"] = fr.redact(txt)
        return entry(r)
def run_isolated(root, repo, timeout=600):
    """Run server + browser together in a fresh user+net namespace with only loopback up: no outside network is possible."""
    out = os.path.join(root, "_out", repo + ".json"); os.makedirs(os.path.dirname(out), exist_ok=True)
    extra = json.dumps({k: v for k, v in HINTS.items() if k == repo or k.startswith(repo + ":")})
    code = f"import sys,json; sys.path.insert(0,{os.path.dirname(os.path.dirname(os.path.abspath(__file__)))!r}); from frl import sweep; sweep.HINTS.update(json.loads({extra!r})); sweep.BUILD_HINTS.update({{k[:-6]:v for k,v in sweep.HINTS.items() if k.endswith(':build')}}); json.dump(sweep.one({root!r},{repo!r}), open({out!r},'w'))"
    p = subprocess.run(["unshare", "-rn", "sh", "-c", 'ip link set lo up && exec python3 -c "$0"', code], timeout=timeout, capture_output=True, text=True)
    if p.returncode or not os.path.isfile(out): return {"score": None, "verdict": "aborted: " + (p.stderr.strip().splitlines() or ["?"])[-1][:150], "hotspots": [], "finals": [], "backend": "python (netns)"}
    return json.load(open(out))
