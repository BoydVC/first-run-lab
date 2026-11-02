"""First-Run Lab prototype: deterministic personas walk a local web app and report where first-time users get stuck."""
import json, sys, time, os, re, hashlib, threading, http.server, functools
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

# ---- statechart (single source of truth; tests check every transition used is legal) ----
TRANSITIONS = {
    "queued": {"launching"},
    "launching": {"exploring", "crashed"},
    "exploring": {"exploring", "stuck", "done", "crashed", "budget_exhausted"},
    "stuck": {"reported"}, "done": {"reported"}, "crashed": {"reported"}, "budget_exhausted": {"reported"},
    "reported": set(),
}
class Session:
    def __init__(s, persona): s.persona, s.state, s.log, s.findings, s.frames = persona, "queued", [], [], []
    def go(s, nxt, why=""):
        if nxt not in TRANSITIONS[s.state]: raise RuntimeError(f"illegal {s.state}->{nxt}")
        s.log.append({"from": s.state, "to": nxt, "why": why, "t": round(time.time(), 3)}); s.state = nxt

SEV = {"blocker": 3, "major": 2, "minor": 1}
def finding(s, kind, sev, target, detail, page):
    shot = f"shots/{s.persona['id']}-{len(s.findings):02d}.png"
    page.screenshot(path=os.path.join(OUT, shot))
    s.findings.append({"persona": s.persona["id"], "kind": kind, "severity": sev, "target": redact(target), "detail": redact(detail), "evidence": shot})

def frame(s, page, caption):
    p = f"frames/{s.persona['id']}-{len(s.frames):02d}.png"; page.screenshot(path=os.path.join(OUT, p)); s.frames.append((p, caption))

PERSONAS = [
  {"id": "skimmer", "label": "Skimmer", "viewport": (1280, 800), "patience_ms": 2000, "goal": "complete the main call to action"},
  {"id": "keyboard", "label": "Keyboard-only", "viewport": (1280, 800), "patience_ms": 3000, "goal": "reach every control with Tab"},
  {"id": "phone", "label": "Phone thumb", "viewport": (375, 740), "patience_ms": 2500, "goal": "use it one-handed on a phone"},
  {"id": "screenreader", "label": "Screen reader", "viewport": (1280, 800), "patience_ms": 3000, "goal": "understand every control by its name"},
  {"id": "linkchecker", "label": "Curious clicker", "viewport": (1280, 800), "patience_ms": 3000, "goal": "open every link"},
]

def controls(page):
    return page.evaluate("""()=>[...document.querySelectorAll('a,button,input,select,textarea,[onclick],[role=button]')].map((e,i)=>{
      e.dataset.frl=i; const r=e.getBoundingClientRect(); const lab=e.labels&&e.labels.length?e.labels[0].innerText:'';
      return {i, tag:e.tagName.toLowerCase(), text:(e.innerText||e.value||'').trim().slice(0,40),
        name:(e.getAttribute('aria-label')||lab||e.getAttribute('title')||'').trim(), placeholder:e.getAttribute('placeholder')||'',
        role:e.getAttribute('role')||'', key:(e.getAttribute('aria-label')||(e.labels&&e.labels.length?e.labels[0].innerText:'')||e.getAttribute('placeholder')||(e.tagName==='SELECT'?'':(e.innerText||''))||e.id||e.tagName).trim().split(String.fromCharCode(10))[0].slice(0,30), tabindex:e.tabIndex, w:r.width, h:r.height, href:e.getAttribute('href')||'',
        vis: !!(e.offsetParent||e.getClientRects().length) && r.width>0 && r.height>0 && getComputedStyle(e).visibility!=='hidden' && !e.closest('[aria-hidden=true],[inert],dialog:not([open])') && !e.disabled,
        clickOnly: e.hasAttribute('onclick') && !['a','button','input','select'].includes(e.tagName.toLowerCase())}})""")
def visible(page): return [c for c in controls(page) if c["vis"]]

def dismiss_overlays(page):
    """Close a first-visit help/modal the way a person would (Escape, then a close-ish button) so it isn't mistaken for the app."""
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    for c in visible(page):
        if re.fullmatch(r"\s*(got it|close|dismiss|ok|okay|skip|×|✕|continue)\s*!?", c["text"] or c["name"], re.I):
            if page.evaluate(f"!!document.querySelector(\"[data-frl='{c['i']}']\").closest('dialog,[role=dialog],[aria-modal=true],.modal,.overlay,.help')"):
                page.click(f"[data-frl='{c['i']}']", timeout=2000); page.wait_for_timeout(150); return c["key"]
    return None

REDACT = [w for w in os.environ.get("FRL_REDACT", "").split(",") if w.strip()]
def redact(t):
    for w in REDACT: t = re.sub(r"\b" + re.escape(w.strip()) + r"\b", "[name]", t, flags=re.I)
    return t

SYNTH = {"date": "2026-01-15", "time": "09:30", "datetime-local": "2026-01-15T09:30", "month": "2026-01", "week": "2026-W03", "number": "3", "email": "visitor@example.test", "tel": "", "url": "https://example.test", "search": "test"}
def fill_form(page):
    for c in visible(page):
        if c["tag"] in ("input", "textarea"):
            t = (page.get_attribute(f"[data-frl='{c['i']}']", "type") or "text").lower()
            v = SYNTH.get(t, "" if t in ("checkbox", "radio", "file", "range", "color", "submit", "button", "hidden", "image", "reset") else "Test Visitor")
            if v:
                try: page.fill(f"[data-frl='{c['i']}']", v, timeout=2000)
                except Exception: pass  # an unfillable field must not crash the persona
        if c["tag"] == "select":
            opts = page.eval_on_selector(f"[data-frl='{c['i']}']", "e=>[...e.options].map(o=>o.value||o.text).filter(Boolean)")
            if opts: page.select_option(f"[data-frl='{c['i']}']", index=min(1, len(opts) - 1))

def arm_feedback(page):
    page.evaluate("""()=>{window.__frlFb=0; window.__frlUrl=location.href; if(window.__frlObs) window.__frlObs.disconnect();
      window.__frlObs=new MutationObserver(ms=>{for(const m of ms){const t=m.target.nodeType===1?m.target:m.target.parentElement;
        if(t&&(t.closest('[role=alert],[role=status],[aria-live]')||t.offsetParent!==null||t.getClientRects().length)) window.__frlFb++}});
      window.__frlObs.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','class','hidden','aria-invalid']});
      window.__frlCv=()=>[...document.querySelectorAll('canvas')].map(c=>{try{const d=c.toDataURL();let h=0;for(let i=0;i<d.length;i+=7)h=(h*31+d.charCodeAt(i))|0;return h}catch(e){return 0}}).join(',');
      window.__frlCv0=window.__frlCv(); window.__frlF0=document.activeElement;}""")
def watch_feedback(page, ms):
    t0 = time.time()
    while (time.time() - t0) * 1000 < ms:
        try:
            if page.evaluate("window.__frlFb>0 || location.href!==window.__frlUrl || !!document.querySelector(':invalid:focus') || window.__frlCv()!==window.__frlCv0 || (document.activeElement!==window.__frlF0 && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))"): return round((time.time() - t0) * 1000)
        except Exception: return round((time.time() - t0) * 1000)  # navigated
        page.wait_for_timeout(100)
    return None

def run_persona(pw, persona, url, budget, kind="form"):
    s = Session(persona); s.go("launching")
    try:
        b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": persona["viewport"][0], "height": persona["viewport"][1]}, has_touch=persona["id"] == "phone")
        page = ctx.new_page(); s.api_fail = []
        s.api_ok = []
        page.on("response", lambda r: (s.api_fail if r.status >= 400 else s.api_ok).append(f"{urlparse(r.url).path} {r.status}") if urlparse(r.url).path.startswith("/api") else None)
        page.route("**/*", lambda r: r.continue_() if urlparse(r.request.url).hostname in ALLOW else r.abort())
        page.goto(url); s.go("exploring", "loaded"); frame(s, page, f"{persona['label']}: lands on the page")
        if dismiss_overlays(page): frame(s, page, "closes the welcome/help overlay")
        steps, pid = 0, persona["id"]
        cs = visible(page)
        here = urlparse(page.url).netloc
        local = lambda c: not (c["tag"] == "a" and urlparse(c["href"]).netloc not in ("", here))
        cta = [c for c in cs if local(c) and (c["tag"] in ("button", "a") or c["role"] == "button" or c["clickOnly"]) and not re.search(r"export|download|print|reset|delete|clear|import|copy|help", c["text"] + c["name"], re.I) and re.search(r"\b(sign|start|join|submit|buy|go|add|save|create|new|play|begin|plan|calculate|search|send)\b", c["text"] + c["name"], re.I)]
        if pid == "skimmer":
            if not cta: finding(s, "no_clear_cta", "minor" if kind == "dashboard" else "major", "page", "No obvious primary action found" + (" (dashboard: read-only is fine)" if kind == "dashboard" else ""), page)
            else:
                c = cta[0]; arm_feedback(page)
                try: page.click(f"[data-frl='{c['i']}']", timeout=3000)
                except Exception as e:
                    if "Timeout" not in str(e): raise
                    finding(s, "unclickable_cta", "major", c["key"], "Main action can't be clicked: something covers it or it never stops moving", page)
                    s.go("stuck", "main action unclickable"); c = None
                steps += 1
                if c:
                    ms = watch_feedback(page, persona["patience_ms"]); frame(s, page, "clicks the main button with the form empty")
                    if ms is None: finding(s, "silent_failure", "blocker", c["key"], "Clicked the main action with empty fields: nothing happened, no error", page)
                    fill_form(page); arm_feedback(page)
                    try: page.click(f"[data-frl='{c['i']}']", timeout=3000); again = True
                    except Exception as e:
                        if "Timeout" not in str(e): raise
                        again = False  # the first click moved the app on (button gone/covered) = it responded
                    steps += 1
                    ms = watch_feedback(page, persona["patience_ms"]) if again else 0; frame(s, page, "fills the form, clicks again")
                    if ms is None:
                        finding(s, "slow_or_no_confirmation", "major", c["key"], f"No confirmation within {persona['patience_ms']} ms", page)
                        s.go("stuck", "gave up waiting"); 
        elif pid == "keyboard":
            seen, nofocus = set(), set()
            first = None
            for _ in range(len(cs) + 5):  # Tab presses don't spend the step budget
                page.keyboard.press("Tab")
                info = page.evaluate("""()=>{const e=document.activeElement; if(!e||e===document.body) return null;
                  const st=getComputedStyle(e); return {i:e.dataset.frl, outline:st.outlineStyle!=='none'&&st.outlineWidth!=='0px', shadow:st.boxShadow!=='none'}}""")
                if info and info["i"] is not None:
                    if info["i"] == first: break  # focus wrapped
                    first = first or info["i"]
                    seen.add(int(info["i"]))
                    if not info["outline"] and not info["shadow"]: nofocus.add(int(info["i"]))
            steps += 1; frame(s, page, "tabs through the page")
            if nofocus: finding(s, "invisible_focus", "major", "page", f"{len(nofocus)} controls show no focus ring", page)
            for c in cs:
                if c["i"] not in seen: finding(s, "unreachable_by_keyboard", "blocker", c["key"], "Control can't be reached with Tab", page)
        elif pid == "phone":
            ow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            if ow > 4: finding(s, "horizontal_scroll", "minor", "page", f"Page is {ow}px wider than the phone screen", page)
            for c in cs:
                if not c["w"] or c["tag"] == "a": continue
                m = min(c["w"], c["h"])
                if m < 24: finding(s, "tiny_tap_target", "major", c["key"], f"{int(c['w'])}x{int(c['h'])}px, under WCAG 2.5.8's 24px", page)
                elif m < 44 and c["tag"] in ("button",) or (m < 44 and c["clickOnly"]): finding(s, "small_tap_target", "minor", c["key"], f"{int(c['w'])}x{int(c['h'])}px, under the 44px comfort size", page)
            steps += 1; frame(s, page, "checks thumb-size targets")
        elif pid == "screenreader":
            for c in cs:
                name = c["name"] or (c["text"] if c["tag"] in ("a", "button") or c["clickOnly"] or c["role"] == "button" else "")
                if c["tag"] in ("input", "select") and not c["name"]: finding(s, "unlabeled_field", "major", c["key"], "Field has no label (placeholder isn't a label)", page)
                elif not re.search(r"[A-Za-z0-9]", name or ""): finding(s, "unnamed_control", "blocker", c["key"], "Control has no readable name", page)
                if c["clickOnly"] and not c["role"]: finding(s, "fake_button", "major", c["key"], "Clickable div isn't announced as a button", page)
            steps += 1; frame(s, page, "listens for control names")
        elif pid == "linkchecker":
            from urllib.parse import urljoin
            for c in [c for c in cs if c["tag"] == "a" and c["href"] and not c["href"].startswith(("#", "mailto:", "tel:", "javascript:")) and local(c)][:budget]:
                r = page.request.get(urljoin(page.url, c["href"])); steps += 1  # outside links can't be checked offline: skipped, not failed
                if r.status >= 400: finding(s, "dead_link", "major", c["key"], f"Link returns HTTP {r.status}", page)
            frame(s, page, "opens every link")
        if s.state == "exploring": s.go("budget_exhausted" if steps >= budget else "done", f"{steps} steps")
        b.close()
    except Exception as e:
        if s.state != "reported": s.go("crashed", str(e)[:200])
    s.go("reported"); return s

def merge(sessions):
    hot = {}
    for s in sessions:
        for f in s.findings:
            k = f["target"]; h = hot.setdefault(k, {"kind": f["kind"], "kinds": [], "target": f["target"], "severity": f["severity"], "personas": [], "evidence": f["evidence"], "detail": f["detail"], "details": []})
            if f["kind"] not in h["kinds"]: h["kinds"].append(f["kind"]); h["details"].append(f["detail"])
            if f["persona"] not in h["personas"]: h["personas"].append(f["persona"])
            if SEV[f["severity"]] > SEV[h["severity"]]: h["severity"] = f["severity"]
    out = sorted(hot.values(), key=lambda h: (-SEV[h["severity"]], -len(h["personas"])))
    for n, h in enumerate(out): h["id"] = "F" + hashlib.sha1(h['target'].encode()).hexdigest()[:6]
    return out

PII = [re.compile(p) for p in [r"[\w.+-]+@[\w-]+\.\w+", r"\b\d{3}[-. ]\d{3}[-. ]\d{4}\b", r"\b\d{3}-\d{2}-\d{4}\b"]]
def score(hot):
    pen = {"blocker": 0, "major": 0, "minor": 0}
    for h in hot: pen[h["severity"]] += 1
    return max(0, 100 - min(60, 20 * pen["blocker"]) - min(30, 6 * pen["major"]) - min(10, 2 * pen["minor"]))
def privacy_scan(text): return [p.pattern for p in PII if p.search(text)]

def serve(root, port):
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self,*a): pass
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root) if False else functools.partial(Q, directory=root)
    h.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), h); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

def detect_kind(pw, url):
    """auto: a page with no visible fillable fields is a read-only dashboard."""
    b = pw.chromium.launch(); page = b.new_page(); page.route("**/*", lambda r: r.continue_() if urlparse(r.request.url).hostname in ALLOW else r.abort())
    page.goto(url); dismiss_overlays(page)
    n = sum(1 for c in visible(page) if c["tag"] in ("input", "textarea", "select")); b.close()
    return "form" if n else "dashboard"
def main(url, out, budget=12, kind="form"):
    global OUT, ALLOW; OUT = out; ALLOW = {"127.0.0.1", "localhost"}
    if urlparse(url).hostname not in ALLOW: sys.exit("refusing: only localhost targets allowed in prototype")
    for d in ("shots", "frames"): os.makedirs(os.path.join(out, d), exist_ok=True)
    import urllib.request, urllib.error
    try: st = urllib.request.urlopen(url, timeout=10).status
    except urllib.error.HTTPError as e: st = e.code
    except Exception as e: st = str(e)[:60]
    if st != 200: return {"url": url, "kind": kind, "sessions": [], "hotspots": [], "score": None, "verdict": f"unreachable: landing page returned {st}"}
    with sync_playwright() as pw:
        if kind == "auto": kind = detect_kind(pw, url)
        sessions = [run_persona(pw, p, url, budget, kind) for p in PERSONAS]
    api = sorted({a for x in sessions for a in getattr(x, "api_fail", [])})
    api_ok = any(getattr(x, "api_ok", []) for x in sessions)
    if api and api_ok:  # backend is up but some endpoints fail: a real bug, report it
        for x in sessions:
            if x.persona["id"] == "skimmer":
                for a in api: x.findings.append({"persona": "skimmer", "kind": "broken_api", "severity": "major", "target": a.split()[0], "detail": f"App's own API returned {a.split()[1]}", "evidence": ""})
        api = []
    if api: return {"url": url, "kind": kind, "sessions": [], "hotspots": [], "score": None, "verdict": "needs backend: " + ", ".join(api[:3])}
    hot = merge(sessions)
    rep = {"url": url, "kind": kind, "sessions": [{"persona": s.persona["id"], "final": s.log[-2]["to"], "log": s.log, "findings": len(s.findings)} for s in sessions],
           "hotspots": hot, "score": None if any(s.log[-2]["to"] == "crashed" for s in sessions) else score(hot), "verdict": "inconclusive" if any(s.log[-2]["to"] == "crashed" for s in sessions) else "scored"}
    txt = json.dumps(rep, indent=1)
    leaks = privacy_scan(txt)
    if leaks: sys.exit(f"privacy scan failed: {leaks}")
    open(os.path.join(out, "report.json"), "w").write(txt)
    rows = "".join(f"<tr><td>{h['id']}</td><td class={h['severity']}>{h['severity']}</td><td>{', '.join(k.replace('_',' ') for k in h['kinds'])}</td><td>{h['target']}</td><td>{', '.join(h['personas'])}</td><td>{'<br>'.join(h['details'])}</td><td><img src='{h['evidence']}' width=160></td></tr>" for h in hot)
    open(os.path.join(out, "report.html"), "w").write(f"<!doctype html><meta charset=utf-8><title>First-Run Lab</title><style>body{{font-family:sans-serif}}.blocker{{color:#b00;font-weight:bold}}.major{{color:#c60}}td{{padding:4px;border-bottom:1px solid #ddd}}</style><h1>First-Run Lab — {('score ' + str(rep['score']) + '/100') if rep['score'] is not None else 'INCONCLUSIVE (a persona crashed)'}</h1><p>{len(hot)} hotspots from {len(sessions)} personas on {url}</p><table>{rows}</table>")
    json.dump([[s.persona["label"], f, c] for s in sessions for f, c in s.frames], open(os.path.join(out, "frames.json"), "w"))
    return rep

