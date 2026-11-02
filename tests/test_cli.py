import json, os, subprocess, sys
EX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "examples")
def frl(*a, cwd): return subprocess.run([sys.executable, "-m", "frl.cli", *a], cwd=cwd, capture_output=True, text=True, timeout=300)
def test_cli_run_then_report(tmp_path):
    r = frl("run", os.path.join(EX, "signup.html"), "-o", "out", "--port", "8810", cwd=tmp_path)
    assert r.returncode == 0 and "score:" in r.stdout, r.stderr
    rep = json.load(open(tmp_path / "out" / "report.json")); assert rep["score"] < 50
    assert (tmp_path / "out" / "report.html").exists()
    g = frl("report", "out/report.json", "-o", "board.html", cwd=tmp_path); assert g.returncode == 0
    assert "leaderboard" in (tmp_path / "board.html").read_text()
def test_leaderboard_orders_and_handles_unscored():
    from frl.report import leaderboard
    h = leaderboard({"b": {"score": 60, "hotspots": []}, "a": {"score": 98, "hotspots": []}, "c": {"score": None, "verdict": "needs backend", "hotspots": []}})
    assert h.index(">a<") < h.index(">b<") < h.index(">c<") and "median 98" in h
