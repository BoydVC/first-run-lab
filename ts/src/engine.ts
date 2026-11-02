import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { merge } from "./merge.ts";
import { score } from "./score.ts";
import { assertClean, PrivacyError, redact } from "./privacy.ts";
import { Session } from "./session.ts";
import { replayRun, replaySession } from "./trace.ts";
import type { Box, Control, Finding, FindingKind, Persona, Run, Severity, Verdict } from "./types.ts";

export const TAB_CAP = 500;
export const DEFAULT_ALLOW = ["127.0.0.1", "localhost"];
const blockedUrls: string[] = [];

export class RefuseHost extends Error {
  code = 64;
  constructor(message: string) {
    super(message);
    this.name = "RefuseHost";
  }
}

export function assertAllowed(url: string, allow: Iterable<string>): void {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new RefuseHost(`refusing: not a URL (${url})`);
  }
  if (![...allow].includes(host)) throw new RefuseHost(`refusing: ${host} is not in the host allow-list`);
}

const SYNTH: Record<string, string> = {
  date: "2026-01-15",
  time: "09:30",
  "datetime-local": "2026-01-15T09:30",
  month: "2026-01",
  week: "2026-W03",
  number: "3",
  email: "visitor@example.test",
  tel: "",
  url: "https://example.test",
  search: "test",
};
const SKIP_INPUT = new Set(["checkbox", "radio", "file", "range", "color", "submit", "button", "hidden", "image", "reset"]);
const CTA_VERB = /\b(sign|start|join|submit|buy|go|add|save|create|new|play|begin|plan|calculate|search|send)\b/i;
const CTA_SKIP = /export|download|print|reset|delete|clear|import|copy|help/i;

// Browser source is a string so the test runner cannot inject helpers into the page.
const COLLECT = `(() => {
  const closed = (e) => {
    const det = e.closest("details");
    if (det && !det.open && !e.closest("summary")) return true;
    if (e.closest("[hidden]")) return true;
    let n = e.parentElement;
    while (n) {
      if (n.id) {
        const ctrl = document.querySelector('[aria-controls="' + CSS.escape(n.id) + '"]');
        if (ctrl && ctrl.getAttribute("aria-expanded") === "false") return true;
      }
      if (n.getAttribute("data-state") === "closed" || n.getAttribute("data-collapsed") === "true") return true;
      n = n.parentElement;
    }
    return false;
  };
  const line = (s) => (s || "").trim().split("\\n")[0].slice(0, 30);
  const nodes = [...document.querySelectorAll("a,button,input,select,textarea,[onclick],[role=button]")];
  return nodes.map((el, i) => {
    el.dataset.frl = String(i);
    const r = el.getBoundingClientRect();
    const lab = el.labels && el.labels.length ? el.labels[0].innerText : "";
    const tag = el.tagName.toLowerCase();
    const own = tag === "select" ? "" : (el.innerText || "");
    const key = line(el.getAttribute("aria-label") || lab || el.getAttribute("placeholder") || own || el.id || el.tagName);
    const st = getComputedStyle(el);
    const vis = !!(el.offsetParent || el.getClientRects().length) && r.width > 0 && r.height > 0
      && st.visibility !== "hidden" && !el.closest("[aria-hidden=true],[inert],dialog:not([open])")
      && !el.disabled && !closed(el);
    return {
      i, tag, text: (el.innerText || el.value || "").trim().slice(0, 40),
      name: (el.getAttribute("aria-label") || lab || el.getAttribute("title") || "").trim(),
      placeholder: el.getAttribute("placeholder") || "", role: el.getAttribute("role") || "", key,
      w: r.width, h: r.height, x: r.x, y: r.y, href: el.getAttribute("href") || "", vis,
      clickOnly: el.hasAttribute("onclick") && !["a", "button", "input", "select"].includes(tag),
    };
  });
})()`;

async function visible(page: Page): Promise<Control[]> {
  const all = (await page.evaluate(COLLECT)) as Control[];
  return all.filter((c) => c.vis);
}

function isLocalHref(href: string, pageUrl: string): boolean {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
    return false;
  }
  try {
    return new URL(href, pageUrl).hostname === new URL(pageUrl).hostname;
  } catch {
    return false;
  }
}

async function dismissOverlays(page: Page): Promise<string | null> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  for (const c of await visible(page)) {
    if (!/^\s*(got it|close|dismiss|ok|okay|skip|×|✕|continue)\s*!?$/i.test(c.text || c.name)) continue;
    const inside = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-frl="${c.i}"]`)});
      return !!(el && el.closest("dialog,[role=dialog],[aria-modal=true],.modal,.overlay,.help"));
    })()`);
    if (!inside) continue;
    await page.click(`[data-frl="${c.i}"]`, { timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(150);
    return c.key;
  }
  return null;
}

async function fillForm(page: Page): Promise<void> {
  for (const c of await visible(page)) {
    const sel = `[data-frl="${c.i}"]`;
    if (c.tag === "input" || c.tag === "textarea") {
      const t = ((await page.getAttribute(sel, "type")) || "text").toLowerCase();
      const v = Object.prototype.hasOwnProperty.call(SYNTH, t) ? SYNTH[t] : SKIP_INPUT.has(t) ? "" : "Test Visitor";
      if (v) await page.fill(sel, v, { timeout: 2000 }).catch(() => undefined);
    }
    if (c.tag === "select") {
      const n = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e && e.options ? e.options.length : 0; })()`).catch(() => 0) as number;
      if (n > 0) await page.selectOption(sel, { index: Math.min(1, n - 1) }).catch(() => undefined);
    }
  }
}

const ARM = `(() => {
  const snap = () => {
    const alerts = [...document.querySelectorAll("[role=alert],[role=status],[aria-live]")].map((e) => e.innerText).join("\\n");
    const text = document.body ? document.body.innerText : "";
    let cv = "";
    for (const c of document.querySelectorAll("canvas")) {
      try {
        const d = c.toDataURL();
        let h = 0;
        for (let i = 0; i < d.length; i += 7) h = (h * 31 + d.charCodeAt(i)) | 0;
        cv += h + ",";
      } catch (e) { cv += "0,"; }
    }
    const ae = document.activeElement;
    const focusField = ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) ? (ae.id || ae.tagName) : "";
    const invalid = !!document.querySelector(":invalid:focus");
    let vis = 0;
    if (document.body) {
      for (const e of document.querySelectorAll("body *")) {
        const r = e.getBoundingClientRect();
        const st = getComputedStyle(e);
        if (r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none") vis++;
      }
    }
    return JSON.stringify({ alerts, text, url: location.href, cv, focusField, invalid, vis });
  };
  window.__frlSnap = snap();
  window.__frlSnapFn = snap;
})()`;

export async function armFeedback(page: Page): Promise<void> {
  await page.evaluate(ARM);
}

export async function watchFeedback(page: Page, ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const changed = await page.evaluate(`(() => {
        const prev = JSON.parse(window.__frlSnap);
        const now = JSON.parse(window.__frlSnapFn());
        if (now.alerts !== prev.alerts || now.text !== prev.text || now.url !== prev.url || now.cv !== prev.cv) return true;
        if (now.invalid && !prev.invalid) return true;
        if (now.vis > prev.vis) return true;
        return !!(now.focusField && now.focusField !== prev.focusField);
      })()`);
      if (changed) return Date.now() - t0;
    } catch {
      return Date.now() - t0;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

export interface RunOptions {
  url: string;
  out: string;
  budget?: number;
  kind?: "auto" | "form" | "dashboard";
  personas: Persona[];
  allow?: string[];
  redact?: string[];
  shots?: boolean;
  browser?: Browser;
}

function has(p: Persona, kind: FindingKind): boolean {
  return p.checks.includes(kind);
}

async function shot(page: Page, file: string, box: Box | undefined, viewport: { w: number; h: number }): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (!box) {
    await page.screenshot({ path: file });
    return;
  }
  await page.evaluate(`(() => {
    const b = ${JSON.stringify(box)};
    document.getElementById("frl-ring")?.remove();
    const d = document.createElement("div");
    d.id = "frl-ring";
    const pad = 4;
    d.style.cssText = "position:fixed;left:" + (b.x - pad) + "px;top:" + (b.y - pad) + "px;width:" + (b.w + pad * 2) + "px;height:" + (b.h + pad * 2) + "px;border:3px solid #f59e0b;border-radius:8px;pointer-events:none;z-index:2147483647;box-sizing:border-box";
    document.body.appendChild(d);
  })()`);
  const pad = 8;
  let x = Math.max(0, Math.floor(box.x - pad));
  let y = Math.max(0, Math.floor(box.y - pad));
  let w = Math.ceil(box.w + pad * 2);
  let h = Math.ceil(box.h + pad * 2);
  if (x + w > viewport.w) w = Math.floor(viewport.w - x);
  if (y + h > viewport.h) h = Math.floor(viewport.h - y);
  if (w >= 2 && h >= 2) await page.screenshot({ path: file, clip: { x, y, width: w, height: h } });
  else await page.screenshot({ path: file });
  await page.evaluate(`document.getElementById("frl-ring")?.remove()`);
}

async function runPersona(browser: Browser, persona: Persona, url: string, budget: number, kind: "form" | "dashboard", opts: Required<Pick<RunOptions, "out" | "shots" | "redact">> & { allow: Set<string> }): Promise<Session> {
  const session = new Session(persona);
  const words = opts.redact;
  const add = async (k: FindingKind, sev: Severity, control: string, detail: string, box?: Box) => {
    const n = String(session.findings.length).padStart(2, "0");
    const rel = opts.shots ? `shots/${persona.id}-${n}.png` : "";
    if (opts.shots && rel) {
      try {
        await shot(page, path.join(opts.out, rel), box, persona.viewport);
      } catch {
        /* evidence is best-effort; a screenshot miss must not crash the persona */
      }
    }
    session.findings.push({
      persona: persona.id,
      kind: k,
      severity: sev,
      control: redact(control, words) as Finding["control"],
      detail: redact(detail, words),
      evidence: { shot: rel, ...(box ? { box } : {}) },
      step: session.steps,
    });
  };
  const frame = async (caption: string) => {
    const rel = opts.shots ? `frames/${persona.id}-${String(session.frames.length).padStart(2, "0")}.png` : "";
    if (opts.shots && rel) {
      try {
        await fs.promises.mkdir(path.join(opts.out, "frames"), { recursive: true });
        await page.screenshot({ path: path.join(opts.out, rel) });
      } catch { /* ignore */ }
    }
    session.frames.push({ shot: rel, caption });
  };
  const markStep = () => {
    session.steps += 1;
    session.go("exploring", "step");
  };

  let page!: Page;
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  try {
    session.go("launching", "start");
    context = await browser.newContext({
      viewport: { width: persona.viewport.w, height: persona.viewport.h },
      hasTouch: persona.touch,
      deviceScaleFactor: 1,
    });
    page = await context.newPage();
    page.on("response", (r) => {
      try {
        const p = new URL(r.url()).pathname;
        if (!p.startsWith("/api")) return;
        (r.status() >= 400 ? session.apiFail : session.apiOk).push(`${p} ${r.status()}`);
      } catch { /* ignore */ }
    });
    await page.route("**/*", (route) => {
      let host = "";
      try { host = new URL(route.request().url()).hostname; } catch { /* abort */ }
      if (host && opts.allow.has(host)) return route.continue();
      blockedUrls.push(route.request().url());
      return route.abort();
    });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    session.go("exploring", "loaded");
    await frame(`${persona.label}: lands on the page`);
    if (await dismissOverlays(page)) await frame("closes the welcome/help overlay");

    if (has(persona, "no_clear_cta") || has(persona, "silent_failure") || has(persona, "slow_or_no_confirmation") || has(persona, "unclickable_cta")) {
      await skimmer();
    }
    if (session.state === "exploring" && (has(persona, "unreachable_by_keyboard") || has(persona, "invisible_focus"))) {
      await keyboard();
    }
    if (session.state === "exploring" && (has(persona, "tiny_tap_target") || has(persona, "small_tap_target") || has(persona, "horizontal_scroll"))) {
      await phone();
    }
    if (session.state === "exploring" && (has(persona, "unnamed_control") || has(persona, "unlabeled_field") || has(persona, "fake_button"))) {
      await screenreader();
    }
    if (session.state === "exploring" && has(persona, "dead_link")) await links();
    if (session.state === "exploring") {
      session.go(session.steps >= budget ? "budget_exhausted" : "done", session.steps >= budget ? "budget" : "checks_complete");
    }
  } catch (e) {
    const err = e as Error;
    if (err?.name === "IllegalTransition") throw e;
    session.error = String(err?.message || e).slice(0, 200);
    if (session.state === "launching" || session.state === "exploring") session.go("crashed", "error");
  } finally {
    if (session.state !== "reported" && ["stuck", "done", "budget_exhausted", "crashed"].includes(session.state)) {
      session.go("reported", "report");
    }
    await context?.close().catch(() => undefined);
  }
  replaySession(session.log);
  return session;

  async function skimmer() {
    const cs = await visible(page);
    const pageUrl = page.url();
    const cta = cs.filter((c) => {
      const local = !(c.tag === "a" && c.href && !isLocalHref(c.href, pageUrl) && !c.href.startsWith("#"));
      const actionable = c.tag === "button" || c.tag === "a" || c.role === "button" || c.clickOnly;
      const label = c.text + c.name;
      return local && actionable && !CTA_SKIP.test(label) && CTA_VERB.test(label);
    });
    if (!cta.length) {
      if (has(persona, "no_clear_cta")) {
        await add("no_clear_cta", kind === "dashboard" ? "minor" : "major", "page",
          "No obvious primary action found" + (kind === "dashboard" ? " (dashboard: read-only is fine)" : ""));
      }
      return;
    }
    const c = cta[0];
    const box = { x: c.x, y: c.y, w: c.w, h: c.h };
    await armFeedback(page);
    try {
      await page.click(`[data-frl="${c.i}"]`, { timeout: 3000 });
    } catch (e) {
      if (!/Timeout/i.test(String(e))) throw e;
      if (has(persona, "unclickable_cta") || has(persona, "silent_failure")) {
        await add("unclickable_cta", "major", c.key, "Main action can't be clicked: something covers it or it never stops moving", box);
      }
      markStep();
      session.go("stuck", "gave_up");
      return;
    }
    markStep();
    const ms = await watchFeedback(page, persona.patienceMs);
    await frame("clicks the main button with the form empty");
    if (ms == null && has(persona, "silent_failure")) {
      await add("silent_failure", "blocker", c.key, "Clicked the main action with empty fields: nothing happened, no error", box);
    }
    await fillForm(page);
    await armFeedback(page);
    let again = true;
    try {
      await page.click(`[data-frl="${c.i}"]`, { timeout: 3000 });
    } catch (e) {
      if (!/Timeout/i.test(String(e))) throw e;
      again = false;
    }
    markStep();
    const ms2 = again ? await watchFeedback(page, persona.patienceMs) : 0;
    await frame("fills the form, clicks again");
    if (ms2 == null && has(persona, "slow_or_no_confirmation")) {
      await add("slow_or_no_confirmation", "major", c.key, `No confirmation within ${persona.patienceMs} ms`, box);
      session.go("stuck", "gave_up");
    }
  }

  async function keyboard() {
    await page.evaluate("window.__frlUid = 0");
    const seen = new Set<number>();
    const nofocus = new Set<number>();
    let first: string | null = null;
    for (let n = 0; n < TAB_CAP; n++) {
      await page.keyboard.press("Tab");
      const info = (await page.evaluate(`(() => {
        const e = document.activeElement;
        if (!e || e === document.body || e === document.documentElement) return null;
        if (!e.dataset.frlUid) {
          window.__frlUid = (window.__frlUid || 0) + 1;
          e.dataset.frlUid = String(window.__frlUid);
        }
        const st = getComputedStyle(e);
        return {
          uid: e.dataset.frlUid,
          i: e.dataset.frl || null,
          outline: st.outlineStyle !== "none" && st.outlineWidth !== "0px",
          shadow: st.boxShadow !== "none",
        };
      })()`)) as { uid: string; i: string | null; outline: boolean; shadow: boolean } | null;
      if (!info) continue;
      if (first == null) first = info.uid;
      else if (info.uid === first) break;
      if (info.i != null && info.i !== "") {
        const id = Number(info.i);
        seen.add(id);
        if (!info.outline && !info.shadow) nofocus.add(id);
      }
    }
    markStep();
    await frame("tabs through the page");
    const cs = await visible(page);
    if (has(persona, "invisible_focus") && nofocus.size) {
      await add("invisible_focus", "major", "page", `${nofocus.size} controls show no focus ring`);
    }
    if (has(persona, "unreachable_by_keyboard")) {
      for (const c of cs) {
        if (!seen.has(c.i)) await add("unreachable_by_keyboard", "blocker", c.key, "Control can't be reached with Tab", { x: c.x, y: c.y, w: c.w, h: c.h });
      }
    }
  }

  async function phone() {
    const cs = await visible(page);
    if (has(persona, "horizontal_scroll")) {
      const ow = (await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")) as number;
      if (ow > 4) await add("horizontal_scroll", "minor", "page", `Page is ${ow}px wider than the phone screen`);
    }
    for (const c of cs) {
      if (!c.w || c.tag === "a") continue;
      const m = Math.min(c.w, c.h);
      const box = { x: c.x, y: c.y, w: c.w, h: c.h };
      if (m < 24 && has(persona, "tiny_tap_target")) {
        await add("tiny_tap_target", "major", c.key, `${Math.round(c.w)}x${Math.round(c.h)}px, under WCAG 2.5.8's 24px`, box);
      } else if (m < 44 && (c.tag === "button" || c.clickOnly) && has(persona, "small_tap_target")) {
        await add("small_tap_target", "minor", c.key, `${Math.round(c.w)}x${Math.round(c.h)}px, under the 44px comfort size`, box);
      }
    }
    markStep();
    await frame("checks thumb-size targets");
  }

  async function screenreader() {
    for (const c of await visible(page)) {
      const namedByText = c.tag === "a" || c.tag === "button" || c.clickOnly || c.role === "button";
      const readable = c.name || (namedByText ? c.text : "");
      const box = { x: c.x, y: c.y, w: c.w, h: c.h };
      if ((c.tag === "input" || c.tag === "select") && !c.name && has(persona, "unlabeled_field")) {
        await add("unlabeled_field", "major", c.key, "Field has no label (placeholder isn't a label)", box);
      } else if (!/[A-Za-z0-9]/.test(readable || "") && has(persona, "unnamed_control")) {
        await add("unnamed_control", "blocker", c.key, "Control has no readable name", box);
      }
      if (c.clickOnly && !c.role && has(persona, "fake_button")) {
        await add("fake_button", "major", c.key, "Clickable div isn't announced as a button", box);
      }
    }
    markStep();
    await frame("listens for control names");
  }

  async function links() {
    const pageUrl = page.url();
    const cs = (await visible(page)).filter((c) => c.tag === "a" && c.href && isLocalHref(c.href, pageUrl)).slice(0, budget);
    for (const c of cs) {
      const target = new URL(c.href, pageUrl).href;
      const res = await page.request.get(target);
      markStep();
      if (res.status() >= 400) {
        await add("dead_link", "major", c.key, `Link returns HTTP ${res.status()}`, { x: c.x, y: c.y, w: c.w, h: c.h });
      }
    }
    await frame("opens every link");
  }
}

async function detectKind(browser: Browser, url: string, allow: Set<string>): Promise<"form" | "dashboard"> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => {
      let host = "";
      try { host = new URL(route.request().url()).hostname; } catch { /* abort */ }
      if (host && allow.has(host)) return route.continue();
      return route.abort();
    });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await dismissOverlays(page);
    const n = (await visible(page)).filter((c) => c.tag === "input" || c.tag === "textarea" || c.tag === "select").length;
    return n ? "form" : "dashboard";
  } finally {
    await context.close();
  }
}

function publicSession(s: Session): Run["sessions"][number] {
  return {
    persona: s.persona.id,
    label: s.persona.label,
    state: s.state,
    log: s.log,
    findings: s.findings,
    frames: s.frames,
    steps: s.steps,
    ...(s.error ? { error: s.error } : {}),
  };
}

export async function landingStatus(url: string): Promise<number | string> {
  try {
    const res = await fetch(url);
    return res.status;
  } catch (e) {
    return String(e).slice(0, 80);
  }
}

export async function run(opts: RunOptions): Promise<Run> {
  const allow = new Set(opts.allow?.length ? opts.allow : DEFAULT_ALLOW);
  assertAllowed(opts.url, allow);
  const budget = opts.budget ?? 12;
  const words = opts.redact ?? [];
  const shots = opts.shots ?? false;
  const startedAt = new Date().toISOString();
  const id = createHash("sha1").update([opts.url, String(budget), opts.personas.map((p) => p.id).join(",")].join("|")).digest("hex").slice(0, 12);

  const status = await landingStatus(opts.url);
  if (status !== 200) {
    return {
      schema: 1, id, url: opts.url, startedAt, kind: opts.kind === "dashboard" ? "dashboard" : "form",
      sessions: [], hotspots: [], blocked: [], runLog: [],
      verdict: { kind: "unreachable", detail: `landing page returned ${status}` },
    };
  }

  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const staging = opts.out + ".partial";
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(staging, { recursive: true });
  blockedUrls.length = 0;
  try {
    let kind: "form" | "dashboard" = opts.kind === "dashboard" || opts.kind === "form" ? opts.kind : "form";
    if (!opts.kind || opts.kind === "auto") kind = await detectKind(browser, opts.url, allow);
    const sessions = await Promise.all(opts.personas.map((p) =>
      runPersona(browser, p, opts.url, budget, kind, { out: staging, shots, redact: words, allow })));
    for (const s of sessions) replaySession(s.log);

    const fails = [...new Set(sessions.flatMap((s) => s.apiFail))].sort();
    const anyOk = sessions.some((s) => s.apiOk.length);
    if (fails.length && anyOk) {
      const host = sessions.find((s) => s.persona.id === "skimmer") ?? sessions[0];
      for (const a of fails) {
        const [target, code] = a.split(" ");
        host.findings.push({
          persona: host.persona.id,
          kind: "broken_api",
          severity: "major",
          control: redact(target, words) as Finding["control"],
          detail: redact(`App's own API returned ${code}`, words),
          evidence: { shot: "" },
          step: host.steps,
        });
      }
      fails.length = 0;
    }
    const blocked = [...blockedUrls];
    if (fails.length) {
      await fs.promises.rm(staging, { recursive: true, force: true });
      return {
        schema: 1, id, url: opts.url, startedAt, kind, sessions: sessions.map(publicSession),
        hotspots: [], blocked, runLog: [],
        verdict: { kind: "needs_backend", detail: fails.slice(0, 3).join(", ") },
      };
    }

    const crashed = sessions.filter((s) => s.log.at(-1)?.from === "crashed" || s.log.at(-2)?.to === "crashed").map((s) => s.persona.id);
    const findings = sessions.flatMap((s) => s.findings);
    const hotspots = merge(findings);
    const verdict: Verdict = crashed.length
      ? { kind: "inconclusive", crashed }
      : { kind: "scored", score: score(hotspots) };
    const runLog = [
      { from: "idle", to: "running", why: "start", atMs: 0 },
      verdict.kind === "scored"
        ? { from: "running", to: "scored", why: "all_clear", atMs: 1 }
        : { from: "running", to: "inconclusive", why: "any_crashed", atMs: 1 },
    ];
    replayRun(runLog);
    const rep: Run = {
      schema: 1, id, url: opts.url, startedAt, kind,
      sessions: sessions.map(publicSession),
      hotspots, verdict, blocked, runLog,
    };
    const json = JSON.stringify(rep, null, 2);
    const html = reportHtml(rep);
    assertClean(json + "\n" + html);
    await fs.promises.writeFile(path.join(staging, "run.json.tmp"), json);
    await fs.promises.rename(path.join(staging, "run.json.tmp"), path.join(staging, "run.json"));
    await fs.promises.writeFile(path.join(staging, "report.html"), html);
    await fs.promises.rm(opts.out, { recursive: true, force: true });
    await fs.promises.rename(staging, opts.out);
    return rep;
  } catch (e) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw e;
  } finally {
    if (ownBrowser) await browser.close();
  }
}

export function reportHtml(rep: Run): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const head = rep.verdict.kind === "scored" ? `score ${rep.verdict.score}/100` : rep.verdict.kind.toUpperCase();
  const rows = rep.hotspots.map((h) =>
    `<tr><td>${esc(h.id)}</td><td class=${h.severity}>${h.severity}</td><td>${esc(h.kinds.join(", "))}</td><td>${esc(String(h.control))}</td><td>${esc(h.personas.join(", "))}</td><td>${h.details.map(esc).join("<br>")}</td></tr>`,
  ).join("");
  return `<!doctype html><meta charset=utf-8><title>First-Run Lab</title><style>body{font-family:sans-serif}.blocker{color:#b00;font-weight:bold}.major{color:#c60}td{padding:4px;border-bottom:1px solid #ddd}</style><h1>First-Run Lab — ${esc(head)}</h1><p>${rep.hotspots.length} hotspots from ${rep.sessions.length} personas on ${esc(rep.url)}</p><table>${rows}</table>`;
}

export function gateCode(rep: Run, min: number): number {
  if (rep.verdict.kind === "scored") return rep.verdict.score >= min ? 0 : 1;
  return 2;
}
