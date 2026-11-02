"""Leaderboard HTML from a sweep JSON ({app: {score, verdict, hotspots}})."""
import html, json, os
def leaderboard(results, title="First-Run Lab leaderboard"):
    rows = sorted(results.items(), key=lambda kv: (kv[1].get("score") is None, -(kv[1].get("score") or 0), kv[0]))
    def color(s): return "#16a34a" if s >= 90 else "#ca8a04" if s >= 70 else "#dc2626"
    tr = []
    for i, (name, r) in enumerate(rows, 1):
        s = r.get("score"); kinds = sorted({k for h in r.get("hotspots", []) for k in h["kinds"]})
        bar = f"<div class=bar style='width:{s}%;background:{color(s)}'></div>" if s is not None else ""
        tr.append(f"<tr><td>{i if s is not None else '–'}</td><td>{html.escape(name)}</td><td class=n>{s if s is not None else '—'}</td><td class=b>{bar}</td>"
                  f"<td>{html.escape(', '.join(k.replace('_', ' ') for k in kinds) or r.get('verdict', ''))}</td></tr>")
    scored = [r["score"] for _, r in rows if r.get("score") is not None]
    med = sorted(scored)[len(scored) // 2] if scored else "—"
    return (f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>{html.escape(title)}</title>"
            "<style>body{font-family:system-ui,sans-serif;margin:24px;max-width:1000px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:left}"
            ".n{font-weight:700;text-align:right}.b{width:30%}.bar{height:12px;border-radius:6px}</style>"
            f"<h1>{html.escape(title)}</h1><p>{len(rows)} apps · {len(scored)} scored · median {med}</p>"
            "<table><tr><th>#</th><th>App</th><th>Score</th><th></th><th>Findings</th></tr>" + "".join(tr) + "</table>")
def write(src, out):
    data = json.load(open(src))
    if "hotspots" in data and "url" in data: data = {os.path.basename(os.path.dirname(os.path.abspath(src))) or "app": data}
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True); open(out, "w").write(leaderboard(data)); return out
