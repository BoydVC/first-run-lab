# First-Run Lab

Five synthetic first-time users walk a **local** web app. You get a 0–100 score, the one control that tripped them up, and an HTML report.

![v2 demo](screenshots/demo-ts.gif)

## v2 quickstart (about two minutes)

Node 22. From the repo:

```bash
cd ts
npm install
npx playwright install chromium
npx first-run-lab run http://127.0.0.1:PORT
```

No server of your own yet? The synthetic Pinecrest Bake Sale page is in `examples/`:

```bash
npx first-run-lab run ../examples/signup.html
npx first-run-lab run ../examples/signup-fixed.html
npx first-run-lab diff runs/<bad-id> runs/<fixed-id>
npx first-run-lab serve
```

The terminal leads with a sentence, then the score, then where to open the report:

```
First-Run Lab

Sign up tripped up 4 of 5 first-time users

  score   36 / 100
  url     http://127.0.0.1:PORT

  blocker  Sign up    4 of 5
           Clicked Sign up and nothing happened — no error and no next step.
           Fix: When the action can't finish, say what's missing in an alert.

  report  runs/<id>/report.html
```

Open that HTML file. Hotspots are ranked by severity, then by how many personas hit them. Each one has a cropped screenshot with a highlight ring, a plain-English line about what a first-timer experienced, and one fix hint per finding kind. `diff` writes a before/after slider. If any persona crashes, the dial goes grey and reads **Inconclusive**.

`npx first-run-lab serve` is the dashboard: run history, the fleet leaderboard from `sweep`, and the session statechart drawn from the same transition table the TLA+ model checks. It is built to score at least 90 against itself.

| Command | What you get |
|---|---|
| `run <url\|file>` | Five personas, a score, `runs/<id>/report.html` |
| `diff <runA> <runB>` | What the fix resolved, plus a before/after slider |
| `gate <url> --min 80` | Exit 0 at or above the bar, 1 below, 2 if inconclusive |
| `replay <run> --gif out.gif` | A captioned GIF, refused if the privacy scan hits |
| `sweep --ports 4300-4399` | A leaderboard of whatever is listening on those local ports |
| `serve` | Run history, leaderboard, statechart |

Scoring is `100 − min(60, 20·blockers) − min(30, 6·majors) − min(10, 2·minors)`. Only `127.0.0.1` and `localhost` are allowed unless you pass `--allow`. A remote URL exits 64 before a browser starts.

Parity with the Python v1 engine, including two intentional divergences, is in [`ts/PARITY.md`](ts/PARITY.md).

## v1 quickstart

The Python engine in `src/frl` is still the reference oracle. Needs Python 3.9+. From the repo folder:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
python -m playwright install chromium
frl run examples/signup.html
frl run examples/signup-fixed.html -o frl-out-fixed --port 8766
frl report frl-out/report.json -o leaderboard.html
```

You'll see the broken signup page score low, with "Sign up" as the top hotspot, while the fixed page scores 100. Open `frl-out/report.html` for the full report and `leaderboard.html` for the leaderboard.

Sample output: [`examples/report-demo.html`](examples/report-demo.html) and [`examples/leaderboard-demo.html`](examples/leaderboard-demo.html). The media is rebuilt with `tools/make_media.py`, which makes the demo GIF from synthetic pages only, and `tools/make_reveal.py SWEEP.json reveal.mp4`. Both OCR-check frames before writing.

## Commands

| Command | What it does |
|---|---|
| `frl run TARGET [-o DIR] [--kind auto\|form\|dashboard]` | Scores one page. TARGET is a local file, a local folder (serves `index.html`) or an `http://127.0.0.1:PORT/` URL. Writes `report.json`, `report.html` and screenshots. |
| `frl sweep ROOT [-o sweep.json] [--hints hints.json]` | Scores every app folder under ROOT, building template apps first and grouping apps that share code. |
| `frl sweep ROOT --isolated APP …` | Starts each app's own backend and scores it inside a Linux user and network namespace that has only loopback, so it can't reach the internet. Needs `unshare`. |
| `frl report JSON [-o leaderboard.html]` | Builds an HTML leaderboard from a sweep or run JSON. |

**Start hints.** To set an app's start or build command, put a `frl-start: <cmd>` or `frl-build: <cmd>` line in its README, or pass a `--hints` JSON file such as `{"app": "python3 server.py", "app:port": 4300, "app:build": "python3 build.py"}`.

**Scoring.** The score is 100 − min(60, 20·blockers) − min(30, 6·majors) − min(10, 2·minors). An app is marked "needs backend" when none of its `/api` calls succeed, and "unreachable" when the landing page doesn't return 200.

**Safety.** Only localhost targets are allowed. Requests to other hosts are blocked, and off-site links are neither checked nor clicked. Reports are scanned for emails, phone numbers and SSNs, and any run whose report contains one is refused. Set `FRL_REDACT=word1,word2` to blank out extra words.

## Development

```bash
pip install -e ".[test]" && pytest -q
```
