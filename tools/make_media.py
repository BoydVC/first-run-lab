"""Build screenshots/demo.gif from synthetic example pages only. Every frame is OCR-checked for personal info."""
import json, os, re, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright
XF = int(os.environ.get("FRL_XFADE", "14"))
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = lambda n: ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", n)
PII = [r"[\w.+-]+@[\w-]+\.\w+", r"\b\d{3}[-. ]\d{3}[-. ]\d{4}\b", r"\b\d{3}-\d{2}-\d{4}\b"]
BAN = [w for w in os.environ.get("FRL_REDACT", "").split(",") if w]
def ocr_ok(img):
    with tempfile.NamedTemporaryFile(suffix=".png") as t:
        img.save(t.name); txt = subprocess.run(["tesseract", t.name, "-"], capture_output=True, text=True).stdout
    bad = [p for p in PII if re.search(p, txt)] + [w for w in BAN if re.search(rf"\b{re.escape(w)}\b", txt, re.I)]
    return bad, txt
def card(img, cap, W=960, H=640):
    img = img.convert("RGB"); img.thumbnail((W - 40, H - 80)); c = Image.new("RGB", (W, H), "#0f172a")
    c.paste(img, ((W - img.width) // 2, 64)); ImageDraw.Draw(c).text((20, 18), cap, fill="#fbbf24", font=F(26)); return c
def shot(pw, path, w=1200, h=800):
    b = pw.chromium.launch(); p = b.new_page(viewport={"width": w, "height": h}); p.goto("file://" + path); p.wait_for_timeout(300)
    t = tempfile.mktemp(suffix=".png"); p.screenshot(path=t); b.close(); return Image.open(t)
def main(work, out):
    frames = []
    demo = {"demo-signup": {"score": 36, "hotspots": [{"kinds": ["silent_failure", "fake_button"]}]}, "demo-signup-fixed": {"score": 100, "hotspots": []},
            "demo-dashboard": {"score": 88, "hotspots": [{"kinds": ["small_tap_target"]}]}, "demo-store": {"score": 72, "hotspots": [{"kinds": ["horizontal_scroll", "unlabeled_field"]}]},
            "demo-quiz": {"score": 54, "hotspots": [{"kinds": ["dead_link", "invisible_focus"]}]}, "demo-api-app": {"score": None, "verdict": "needs backend", "hotspots": []}}
    sys.path.insert(0, os.path.join(HERE, "src")); from frl.report import leaderboard
    open(os.path.join(work, "demo-board.html"), "w").write(leaderboard(demo, "First-Run Lab leaderboard (demo data)"))
    with sync_playwright() as pw:
        frames.append(card(shot(pw, os.path.join(HERE, "examples", "signup.html")), "A local signup page. Can a first-time user get in?"))
        for label, f, cap in json.load(open(os.path.join(work, "frl-out", "frames.json"))):
            frames.append(card(Image.open(os.path.join(work, "frl-out", f)), f"{label}: {cap.split(': ')[-1]}"[:60]))
        frames.append(card(shot(pw, os.path.join(work, "frl-out", "report.html"), 1200, 900), "$ frl run examples/signup.html  →  36/100"))
        frames.append(card(shot(pw, os.path.join(work, "frl-out-fixed", "report.html")), "After the fix: 100/100"))
        frames.append(card(shot(pw, os.path.join(work, "demo-board.html")), "$ frl report  →  leaderboard"))
    hold = [2600] + [1800] * (len(frames) - 4) + [3200, 3000, 3600]
    out_f, d = [], []
    for i, f in enumerate(frames):  # hold each card, then crossfade to the next
        out_f.append(f); d.append(hold[i])
        if i + 1 < len(frames):
            for k in range(1, XF + 1): out_f.append(Image.blend(f, frames[i + 1], k / (XF + 1))); d.append(60)
    frames = out_f
    for i, f in enumerate(frames):
        bad, _ = ocr_ok(f)
        if bad: sys.exit(f"frame {i}: OCR found {bad}")
    print(f"OCR clean: {len(frames)}/{len(frames)} frames")
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=d, loop=0)
    print(out, os.path.getsize(out) // 1024, "KB", len(frames), "frames")
if __name__ == "__main__": main(sys.argv[1], sys.argv[2])
