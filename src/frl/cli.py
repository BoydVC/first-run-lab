"""frl run | sweep | report"""
import argparse, json, os, sys
def main(argv=None):
    p = argparse.ArgumentParser(prog="frl", description="First-Run Lab: find where first-time users get stuck in a local web app.")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="score one page: a local folder/file, or an http://127.0.0.1 URL")
    r.add_argument("target"); r.add_argument("-o", "--out", default="frl-out"); r.add_argument("--port", type=int, default=8765)
    r.add_argument("--kind", default="auto", choices=["auto", "form", "dashboard"]); r.add_argument("--budget", type=int, default=12)
    s = sub.add_parser("sweep", help="score every app folder under ROOT")
    s.add_argument("root"); s.add_argument("-o", "--out", default="sweep.json")
    s.add_argument("--isolated", nargs="+", metavar="APP", help="run these backend apps with no network (Linux, needs unshare)")
    s.add_argument("--hints", help="JSON file of start/build hints")
    g = sub.add_parser("report", help="build an HTML leaderboard from a sweep or run JSON")
    g.add_argument("json"); g.add_argument("-o", "--out", default="leaderboard.html")
    a = p.parse_args(argv)
    if a.cmd == "report":
        from . import report; print(report.write(a.json, a.out)); return 0
    if getattr(a, "hints", None): os.environ["FRL_HINTS"] = os.path.abspath(a.hints)
    from . import firstrun as fr
    if a.cmd == "run":
        if a.target.startswith("http"): url, srv = a.target, None
        else:
            t = os.path.abspath(a.target); root, page = (t, "index.html") if os.path.isdir(t) else os.path.split(t)
            srv = fr.serve(root, a.port); url = f"http://127.0.0.1:{a.port}/{page}"
        try: rep = fr.main(url, a.out, budget=a.budget, kind=a.kind)
        finally:
            if srv: srv.shutdown()
        print(f"score: {rep['score'] if rep['score'] is not None else rep['verdict']}  ({len(rep['hotspots'])} hotspots)")
        for h in rep["hotspots"][:5]: print(f"  {h['severity']:7} {', '.join(h['kinds'])} -> {h['target']}")
        if rep["score"] is not None: print(f"report: {os.path.join(a.out, 'report.html')}")
        return 0
    from . import sweep
    if a.isolated: res = {app: sweep.run_isolated(os.path.abspath(a.root), app) for app in a.isolated}
    else: res = sweep.run_all(os.path.abspath(a.root))
    json.dump(res, open(a.out, "w"), indent=1); print(f"{len(res)} apps -> {a.out}"); return 0
if __name__ == "__main__": sys.exit(main())
