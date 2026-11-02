"""60 s leaderboard reveal MP4 from a sweep JSON: app names and scores only. OCR-checks one frame per second, plus every drawn string."""
import json, os, re, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont
W, H, FPS, SEC = 1280, 720, 30, 60
F = lambda n: ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", n)
PII = [r"[\w.+-]+@[\w-]+\.\w+", r"\b\d{3}[-. ]\d{3}[-. ]\d{4}\b", r"\b\d{3}-\d{2}-\d{4}\b"]
BAN = [w for w in os.environ.get("FRL_REDACT", "").split(",") if w]
def bad(t): return [w for w in OLD if re.search(rf"\b{re.escape(w)}\b", t, re.I)] + [p for p in PII if re.search(p, t)] + [w for w in BAN if re.search(rf"\b{re.escape(w)}\b", t, re.I)]
# Optional private alias map (JSON {"real-name": "alias"}) via FRL_ALIASES; old names are then banned from every frame.
ALIAS = json.load(open(os.environ["FRL_ALIASES"])) if os.environ.get("FRL_ALIASES") else {}
OLD = list(ALIAS)
def col(s): return "#22c55e" if s >= 90 else "#eab308" if s >= 70 else "#ef4444"
def main(src, out):
    d = json.load(open(src)); rows = sorted([(ALIAS.get(k, k), v["score"]) for k, v in d.items() if v.get("score") is not None], key=lambda x: (-x[1], x[0]))
    n, med = len(rows), sorted(s for _, s in rows)[len(rows) // 2]
    drawn = [f"{i+1}. {a} {s}" for i, (a, s) in enumerate(rows)]
    if any(bad(t) for t in drawn): sys.exit("app name failed privacy check")
    tmp = tempfile.mkdtemp(); ROW, VIS, TOP = 40, 13, 130
    def frame(t):
        im = Image.new("RGB", (W, H), "#0b1220"); g = ImageDraw.Draw(im)
        if t < 5:
            a = min(1, t / 1.5); c = tuple(int(x * a) for x in (251, 191, 36))
            g.text((W // 2, 280), "First-Run Lab", fill=c, font=F(72), anchor="mm")
            g.text((W // 2, 370), "Fleet leaderboard", fill=(int(226*a),)*3, font=F(40), anchor="mm")
            g.text((W // 2, 440), f"{len(d)} apps · {n} scored · median {med}", fill=(int(148*a),)*3, font=F(30), anchor="mm"); return im
        g.text((40, 40), "First-Run Lab · fleet leaderboard", fill="#fbbf24", font=F(34))
        if t >= 50:
            k = min(1, (t - 50) / 1.5)
            g.text((40, 86), f"{n} scored · median {med} · {sum(s >= 90 for _, s in rows)} at 90+ · {sum(s < 70 for _, s in rows)} under 70", fill="#94a3b8", font=F(24))
            for i, (a, s) in enumerate(rows[:10]):
                y = TOP + i * 56; g.text((60, y), f"{i+1:>2}", fill="#64748b", font=F(30)); g.text((130, y), a, fill="#e2e8f0", font=F(30))
                g.rounded_rectangle((640, y + 8, 640 + int(440 * s / 100 * k), y + 30), 8, fill=col(s)); g.text((1110, y), str(s), fill="#fff", font=F(30))
            return im
        p = (t - 5) / 45; shown = min(n, int(p * n) + 1); low = n - shown   # reveal from last place to first
        first = max(0, min(low, n - VIS)); frac = p * n - int(p * n)
        g.text((40, 86), f"revealing #{low + 1}", fill="#94a3b8", font=F(24))
        for i in range(first, min(n, first + VIS)):
            a, s = rows[i]; y = TOP + (i - first) * ROW
            if i < low: continue
            k = min(1, frac * 3) if i == low else 1
            g.text((60, y), f"{i+1:>2}", fill="#64748b", font=F(26)); g.text((130, y), a, fill="#e2e8f0", font=F(26))
            g.rounded_rectangle((640, y + 8, 640 + int(440 * s / 100 * k), y + 28), 8, fill=col(s)); g.text((1110, y), str(s), fill="#fff", font=F(26))
        return im
    for f in range(FPS * SEC):
        im = frame(f / FPS); im.save(f"{tmp}/{f:05d}.png")
        if f % FPS == FPS // 2:
            txt = subprocess.run(["tesseract", f"{tmp}/{f:05d}.png", "-"], capture_output=True, text=True).stdout
            if bad(txt): sys.exit(f"frame {f}: OCR found {bad(txt)}")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", f"{tmp}/%05d.png", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], check=True)
    subprocess.run(["rm", "-rf", tmp]); print(f"{out}: OCR clean on {SEC} sampled frames + {len(drawn)} drawn strings; {n} apps")
if __name__ == "__main__": main(sys.argv[1], sys.argv[2])
