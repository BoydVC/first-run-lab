import json, os, subprocess, sys
from frl import firstrun as fr
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
def test_statechart_all_paths_terminate():
    # every state reaches 'reported', 'reported' is the only sink
    for s in fr.TRANSITIONS:
        seen, stack = set(), [s]
        while stack:
            x = stack.pop(); seen.add(x); stack += [y for y in fr.TRANSITIONS[x] if y not in seen]
        assert "reported" in seen, s
    assert [s for s, t in fr.TRANSITIONS.items() if not t] == ["reported"]
def test_illegal_transition_raises():
    s = fr.Session({"id": "x"})
    try: s.go("reported"); assert False
    except RuntimeError: pass
def test_privacy_scan():
    assert fr.privacy_scan("mail me at a.b@example.com")
    assert not fr.privacy_scan("Sign up button 12x12px")
def test_score_bounds():
    assert fr.score([]) == 100
    assert fr.score([{"severity": "blocker"}] * 9) == 40
def test_refuses_remote():
    r = subprocess.run([sys.executable, "-c", "from frl import firstrun as f; f.main('https://example.com/','/tmp/frl-x')"], capture_output=True, text=True)
    assert "refusing" in r.stderr
def test_bad_vs_fixed():
    srv = fr.serve(FIX, 8792)
    try: bad, good = fr.main("http://127.0.0.1:8792/index.html", "/tmp/frl-bad"), fr.main("http://127.0.0.1:8792/fixed.html", "/tmp/frl-good")
    finally: srv.shutdown()
    assert good["score"] == 100 and bad["score"] < 50
    top = bad["hotspots"][0]; assert top["target"] == "Sign up" and len(top["personas"]) >= 3
    assert all(s["final"] != "crashed" for s in bad["sessions"] + good["sessions"])
def test_sweep_regressions():
    # >12 controls must not be called unreachable; first-visit dialog must not crash the skimmer; hidden controls ignored; redaction applies
    import os; from frl import firstrun as f
    os.environ["FRL_REDACT"] = "B7"; f.REDACT = ["B7"]
    srv = f.serve(os.path.join(FIX, "sweepfix"), 8793)
    try: r = f.main("http://127.0.0.1:8793/many.html", "/tmp/frl-sweepfix")
    finally: srv.shutdown(); f.REDACT = []
    kinds = {k for h in r["hotspots"] for k in h["kinds"]}
    assert r["verdict"] == "scored" and "unreachable_by_keyboard" not in kinds and "no_clear_cta" not in kinds
    assert not any(h["target"] == "Hidden" for h in r["hotspots"]) and "B7" not in json.dumps(r)
def _run(sub, page, port, **kw):
    import os; from frl import firstrun as f
    srv = f.serve(os.path.join(FIX, sub), port)
    try: return f.main(f"http://127.0.0.1:{port}/{page}", f"/tmp/frl-{sub}", **kw)
    finally: srv.shutdown()
def test_o1_canvas_change_counts_as_feedback():
    r = _run("o1", "canvas.html", 8794)
    assert "silent_failure" not in {k for h in r["hotspots"] for k in h["kinds"]}
def test_o2_dashboard_missing_cta_is_minor():
    form = _run("o2", "dash.html", 8795, kind="form"); dash = _run("o2", "dash.html", 8796, kind="dashboard")
    sev = lambda r: [h["severity"] for h in r["hotspots"] if "no_clear_cta" in h["kinds"]]
    assert sev(form) == ["major"] and sev(dash) == ["minor"] and dash["score"] > form["score"]
    assert _run("o2", "dash.html", 8797, kind="auto")["kind"] == "dashboard"
def test_o3_shared_code_grouped():
    import os; from frl import sweep
    root = os.path.join(FIX, "o3")
    g = sweep.code_groups(root, ["a", "b", "c", "d"])  # a/b near-identical CSS; c/d have no code -> not a group; assert len(g) == 1 and sorted(list(g.values())[0]) == ["a", "b"]
    res = {"a": {"hotspots": [1]}, "b": {"hotspots": [1]}}
    rep = sweep.group_report(res, g); assert rep["a"]["group"] == rep["b"]["group"] and rep["b"]["dup_of"] == "a" and "dup_of" not in rep["a"]
def test_o4_python_app_started_with_demo():
    import os; from frl import sweep
    d = os.path.join(FIX, "o4", "pyapp")
    assert "--demo" in sweep.start_hint(d)
    with sweep.launch(d, 8798) as url:
        import urllib.request; assert b"Sample Team" in urllib.request.urlopen(url).read()
def test_o1_fixed_toast_counts_as_feedback():
    r = _run("o1", "toast.html", 8799)
    assert "silent_failure" not in {k for h in r["hotspots"] for k in h["kinds"]}
def test_error_landing_is_unreachable_not_scored():
    r = _run("o1", "missing.html", 8800)
    assert r["score"] is None and r["verdict"].startswith("unreachable")
def test_o4_build_step_runs_offline():
    import os, json; from frl import sweep
    d = os.path.join(FIX, "o4", "pyapp")
    assert sweep.build_hint(d) == "python3 build.py"
    with sweep.launch(d, 8801): pass
    assert json.load(open(os.path.join(d, "built.json")))["net"] is False
def test_covered_cta_is_a_finding_not_a_crash():
    r = _run("o1", "covered.html", 8802)
    assert r["verdict"] == "scored" and any("unclickable_cta" in h["kinds"] for h in r["hotspots"])
def test_template_app_is_built_before_scoring():
    import os, shutil; from frl import sweep
    root = os.path.join(FIX, "tpl")
    shutil.rmtree(os.path.join(root, "tplapp", "dist"), ignore_errors=True)
    d, page, how = sweep.prepare_static(root, "tplapp"); assert how == "build.py" and page.endswith(".html")
    h = open(os.path.join(d, page)).read(); assert "/*__" not in h and "min-height:48px" in h
    d, page, how = sweep.prepare_static(root, "nobuild"); assert how == "inline"
    assert "/*__" not in open(os.path.join(d, page)).read()
    shutil.rmtree(os.path.join(root, "tplapp", "dist"), ignore_errors=True); shutil.rmtree(os.path.join(root, "nobuild", "_frl_built"), ignore_errors=True)
def test_missing_backend_is_inconclusive_not_silent():
    r = _run("o1", "needsapi.html", 8803)
    assert r["score"] is None and r["verdict"].startswith("needs backend")
def test_focus_moving_to_a_field_counts_as_feedback():
    r = _run("o1", "focus.html", 8804)
    assert "silent_failure" not in {k for h in r["hotspots"] for k in h["kinds"]}
def test_role_button_named_by_its_text():
    r = _run("o1", "rolebtn.html", 8805)
    assert "unnamed_control" not in {k for h in r["hotspots"] for k in h["kinds"]}
def test_o4_isolated_run_has_no_network_and_fixed_port():
    import os; from frl import sweep
    root = os.path.join(FIX, "o4")
    sweep.HINTS["netapp"] = "python3 server.py"; sweep.HINTS["netapp:port"] = 4311
    r = sweep.run_isolated(root, "netapp")
    assert r["score"] is not None and r["backend"] == "python (netns)"
    assert "offline" in r["landing_text"] and "ONLINE" not in r["landing_text"]
def test_external_links_not_checked_or_used_as_cta_offline():
    r = _run("o1", "extlinks.html", 8806)
    dead = [h["target"] for h in r["hotspots"] if "dead_link" in h["kinds"]]
    assert dead == ["Local page"]  # the real local 404 is still caught
    assert "silent_failure" not in {k for h in r["hotspots"] for k in h["kinds"]}
def test_partial_api_failure_is_a_finding_not_unscorable():
    r = _run("o1", "partialapi.html", 8807)
    assert r["score"] is not None and any("broken_api" in h["kinds"] for h in r["hotspots"])
