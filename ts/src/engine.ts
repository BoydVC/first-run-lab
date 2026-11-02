import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { Control, Finding, FindingKind, PageKind, Persona, Run, Session } from "./types.js";
import { can, createSession, go, preReport } from "./state.js";
import { PrivacyError, RefusalError, privacyHits } from "./privacy.js";
import { selectPersonas } from "./personas.js";
import { merge, scoreHotspots } from "./score.js";
import { renderReport } from "./report.js";

/** Hard cap on Tab presses. v1 stopped at visible-controls + 5 and false-flagged the rest. */
export const TAB_CAP = 500;

const VERB = /\b(sign|start|join|submit|buy|go|add|save|create|new|play|begin|plan|calculate|search|send)\b/i;
const UTILITY = /export|download|print|reset|delete|clear|import|copy|help/i;
const CLOSE_LABEL = /^\s*(got it|close|dismiss|ok|okay|skip|×|✕|continue)\s*!?$/i;

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

/**
 * Visibility. v1 missed controls inside a closed <details> or a collapsed accordion
 * (height ~0 + overflow clip, or aria-expanded=false). Those are not visible and must
 * not be flagged as nameless controls.
 */
const CONTROLS_JS = `(() => {
  function frlVisible(e, r, cs) {
    if (e.disabled) return false;
    if (!(e.offsetParent || e.getClientRects().length)) return false;
    if (r.width <= 0 || r.height <= 0) return false;
    if (cs.visibility === "hidden") return false;
    if (e.closest("[aria-hidden=true],[inert],dialog:not([open])")) return false;
    const det = e.closest("details");
    if (det && !det.open && !e.closest("summary")) return false;
    if (e.closest("[hidden]")) return false;
    let p = e.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      if (p.id) {
        let ctl = null;
        try { ctl = document.querySelector('[aria-controls="' + CSS.escape(p.id) + '"]'); } catch (err) { ctl = null; }
        if (ctl && ctl.getAttribute("aria-expanded") === "false") return false;
      }
      const pcs = getComputedStyle(p);
      const clipped = pcs.overflow === "hidden" || pcs.overflow === "clip" || pcs.overflowY === "hidden" || pcs.overflowY === "clip" || pcs.overflowX === "hidden" || pcs.overflowX === "clip";
      if (clipped || pcs.contentVisibility === "hidden") {
        const pr = p.getBoundingClientRect();
        if (pcs.contentVisibility === "hidden" || pr.height <= 1 || pr.width <= 1) return false;
      }
      p = p.parentElement;
    }
    return true;
  }
  const sel = "a,button,input,select,textarea,[onclick],[role=button]";
  return [...document.querySelectorAll(sel)].map((e, i) => {
    e.dataset.frl = String(i);
    const r = e.getBoundingClientRect();
    const lab = e.labels && e.labels.length ? e.labels[0].innerText : "";
    const aria = e.getAttribute("aria-label");
    const placeholder = e.getAttribute("placeholder");
    const own = e.tagName === "SELECT" ? "" : (e.innerText || "");
    const key = (aria || lab || placeholder || own || e.id || e.tagName).trim().split("\\n")[0].slice(0, 30);
    const cs = getComputedStyle(e);
    return {
      i,
      tag: e.tagName.toLowerCase(),
      text: (e.innerText || e.value || "").trim().slice(0, 40),
      name: (aria || lab || e.getAttribute("title") || "").trim(),
      placeholder: placeholder || "",
      role: e.getAttribute("role") || "",
      key,
      tabindex: e.tabIndex,
      w: r.width, h: r.height, x: r.x, y: r.y,
      href: e.getAttribute("href") || "",
      vis: frlVisible(e, r, cs),
      clickOnly: e.hasAttribute("onclick") && !["a", "button", "input", "select"].includes(e.tagName.toLowerCase()),
      type: (e.getAttribute("type") || "").toLowerCase()
    };
  });
})()`;

const ARM_JS = `(() => {
  window.__frlFb = 0;
  window.__frlUrl = location.href;
  if (window.__frlObs) window.__frlObs.disconnect();
  window.__frlObs = new MutationObserver(ms => {
    for (const m of ms) {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (t && (t.closest("[role=alert],[role=status],[aria-live]") || t.offsetParent !== null || t.getClientRects().length)) window.__frlFb++;
    }
  });
  window.__frlObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-invalid"] });
  window.__frlCv = () => [...document.querySelectorAll("canvas")].map(c => {
    try {
      const d = c.toDataURL();
      let h = 0;
      for (let i = 0; i < d.length; i += 7) h = (h * 31 + d.charCodeAt(i)) | 0;
      return h;
    } catch (e) { return 0; }
  }).join(",");
  window.__frlCv0 = window.__frlCv();
  window.__frlF0 = document.activeElement;
})()`;

const WATCH_JS = `(() => window.__frlFb > 0 || location.href !== window.__frlUrl || !!document.querySelector(":invalid:focus") || window.__frlCv() !== window.__frlCv0 || (document.activeElement && document.activeElement !== window.__frlF0 && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)))()`;

export interface RunOptions {
  url: string;
  out?: string;
  budget?: number;
  kind?: "auto" | PageKind;
  personas?: string[];
  personaDir?: string;
  allow?: string[];
  redact?: string[];
  evidence?: boolean;
  frames?: boolean;
  browser?: Browser;
  write?: boolean;
  id?: string;
}

function redactWords(extra?: string[]): string[] {
  const env = (process.env.FRL_REDACT || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...env, ...(extra || [])])];
}

function applyRedact(text: string, words: string[]): string {
  let out = text;
  for (const w of words) out = out.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  return out;
}

export function assertLocal(url: string, allow: Set<string>): void {
  let host = "";
  try { host = new URL(url).hostname; } catch { host = ""; }
  if (!allow.has(host)) {
    throw new RefusalError(`refusing: only localhost targets are allowed (${host || url})`, 64);
  }
}

async function readControls(page: Page): Promise<Control[]> {
  return page.evaluate(CONTROLS_JS) as Promise<Control[]>;
}

async function visible(page: Page): Promise<Control[]> {
  return (await readControls(page)).filter((c) => c.vis);
}

function isLocal(c: Control, pageUrl: string): boolean {
  if (c.tag !== "a" || !c.href) return true;
  if (/^(mailto:|tel:|javascript:)/i.test(c.href)) return false;
  try {
    const abs = new URL(c.href, pageUrl);
    const here = new URL(pageUrl);
    return abs.host === here.host;
  } catch {
    return false;
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  for (const c of await visible(page)) {
    if (!CLOSE_LABEL.test(c.text || c.name)) continue;
    const inside = await page.evaluate((i) => {
      const el = document.querySelector(`[data-frl="${i}"]`);
      return !!(el && el.closest("dialog,[role=dialog],[aria-modal=true],.modal,.overlay,.help"));
    }, c.i);
    if (!inside) continue;
    try { await page.click(`[data-frl="${c.i}"]`, { timeout: 2000 }); } catch { /* overlay already gone */ }
    await page.waitForTimeout(150);
    return;
  }
}

async function arm(page: Page): Promise<void> {
  await page.evaluate(ARM_JS);
}

async function watch(page: Page, ms: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const hit = await page.evaluate(WATCH_JS);
      if (hit) return Date.now() - t0;
    } catch {
      return Date.now() - t0;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function fillForm(page: Page): Promise<void> {
  for (const c of await visible(page)) {
    const sel = `[data-frl="${c.i}"]`;
    if (c.tag === "input" || c.tag === "textarea") {
      const t = c.type || "text";
      const v = t in SYNTH ? SYNTH[t] : SKIP_INPUT.has(t) ? "" : "Test Visitor";
      if (v) {
        try { await page.fill(sel, v, { timeout: 2000 }); } catch { /* unfillable must not crash the persona */ }
      }
    }
    if (c.tag === "select") {
      try {
        const n = await page.$eval(sel, (e) => Array.from((e as HTMLSelectElement).options).map((o) => o.value || o.text).filter(Boolean).length);
        if (n) await page.selectOption(sel, { index: Math.min(1, n - 1) });
      } catch { /* ignore */ }
    }
  }
}

async function shoot(page: Page, dest: string | null, box?: { x: number; y: number; w: number; h: number }): Promise<void> {
  if (!dest) return;
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  if (box && box.w > 1 && box.h > 1) {
    await page.evaluate((b) => {
      document.querySelectorAll("[data-frl-ring]").forEach((n) => n.remove());
      const d = document.createElement("div");
      d.setAttribute("data-frl-ring", "1");
      d.style.cssText = `position:fixed;left:${Math.max(0, b.x - 4)}px;top:${Math.max(0, b.y - 4)}px;width:${b.w + 8}px;height:${b.h + 8}px;border:4px solid #e11d48;border-radius:12px;pointer-events:none;z-index:2147483647;box-sizing:border-box;`;
      document.documentElement.appendChild(d);
    }, box);
    const pad = 20;
    let x = Math.max(0, box.x - pad);
    let y = Math.max(0, box.y - pad);
    let w = box.w + pad * 2;
    let h = box.h + pad * 2;
    if (x + w > vp.width) w = vp.width - x;
    if (y + h > vp.height) h = vp.height - y;
    await page.screenshot({ path: dest, clip: { x, y, width: Math.max(1, w), height: Math.max(1, h) } });
    await page.evaluate(() => document.querySelectorAll("[data-frl-ring]").forEach((n) => n.remove()));
  } else {
    await page.evaluate(() => {
      document.querySelectorAll("[data-frl-ring]").forEach((n) => n.remove());
      const h = document.querySelector("h1") || document.body;
      const r = h.getBoundingClientRect();
      const d = document.createElement("div");
      d.setAttribute("data-frl-ring", "1");
      const w = Math.min(Math.max(r.width, 120) + 16, window.innerWidth - 16);
      d.style.cssText = `position:fixed;left:${Math.max(8, r.x - 8)}px;top:${Math.max(8, r.y - 8)}px;width:${w}px;height:${Math.max(r.height, 36) + 16}px;border:4px solid #e11d48;border-radius:12px;pointer-events:none;z-index:2147483647;box-sizing:border-box;`;
      document.documentElement.appendChild(d);
    });
    await page.screenshot({
      path: dest,
      clip: { x: 0, y: 0, width: Math.min(vp.width, 800), height: Math.min(vp.height, 280) },
    });
    await page.evaluate(() => document.querySelectorAll("[data-frl-ring]").forEach((n) => n.remove()));
  }
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || /Timeout/i.test(e.message));
}

interface Ctx {
  page: Page;
  session: Session;
  persona: Persona;
  kind: PageKind;
  budget: number;
  steps: number;
  words: string[];
  evidence: boolean;
  frames: boolean;
  outDir: string;
  tabs: number;
}

function has(persona: Persona, kind: FindingKind): boolean {
  return persona.checks.includes(kind);
}

async function noteFrame(ctx: Ctx, caption: string): Promise<void> {
  if (!ctx.frames) return;
  const rel = `frames/${ctx.persona.id}-${String(ctx.session.frames.length).padStart(2, "0")}.png`;
  mkdirSync(join(ctx.outDir, "frames"), { recursive: true });
  await ctx.page.screenshot({ path: join(ctx.outDir, rel) });
  ctx.session.frames.push({ shot: rel, caption });
}

async function finding(ctx: Ctx, kind: FindingKind, severity: Finding["severity"], control: string, detail: string, box?: Control): Promise<void> {
  const rel = ctx.evidence ? `shots/${ctx.persona.id}-${String(ctx.session.findings.length).padStart(2, "0")}.png` : "";
  if (rel) {
    mkdirSync(join(ctx.outDir, "shots"), { recursive: true });
    const b = box ? { x: box.x, y: box.y, w: box.w, h: box.h } : undefined;
    await shoot(ctx.page, join(ctx.outDir, rel), b);
  }
  const key = control === "page" ? "page" : applyRedact(control, ctx.words);
  ctx.session.findings.push({
    persona: ctx.persona.id,
    kind,
    severity,
    control: key,
    detail: applyRedact(detail, ctx.words),
    evidence: { shot: rel, box: box ? { x: box.x, y: box.y, w: box.w, h: box.h } : undefined },
    step: ctx.steps,
  });
}

function ctas(cs: Control[], pageUrl: string): Control[] {
  return cs.filter((c) => {
    if (!isLocal(c, pageUrl)) return false;
    const clickable = c.tag === "button" || c.tag === "a" || c.role === "button" || c.clickOnly;
    if (!clickable) return false;
    const blob = `${c.text} ${c.name}`;
    if (UTILITY.test(blob)) return false;
    return VERB.test(blob);
  });
}

async function runSkimmer(ctx: Ctx, cs: Control[]): Promise<void> {
  const want =
    has(ctx.persona, "no_clear_cta") || has(ctx.persona, "silent_failure") || has(ctx.persona, "slow_or_no_confirmation");
  if (!want) return;
  const cta = ctas(cs, ctx.page.url());
  if (!cta.length) {
    if (has(ctx.persona, "no_clear_cta")) {
      const dash = ctx.kind === "dashboard";
      await finding(
        ctx,
        "no_clear_cta",
        dash ? "minor" : "major",
        "page",
        "No obvious primary action found" + (dash ? " (dashboard: read-only is fine)" : ""),
      );
    }
    ctx.steps += 1;
    return;
  }
  const c = cta[0];
  await arm(ctx.page);
  let clicked = true;
  try {
    await ctx.page.click(`[data-frl="${c.i}"]`, { timeout: 3000 });
  } catch (e) {
    if (!isTimeout(e)) throw e;
    clicked = false;
    ctx.steps += 1;
    await finding(ctx, "unclickable_cta", "major", c.key, "Main action can't be clicked: something covers it or it never stops moving", c);
    go(ctx.session, "stuck", "main action unclickable");
    return;
  }
  ctx.steps += 1;
  const ms = await watch(ctx.page, ctx.persona.patienceMs);
  await noteFrame(ctx, "clicks the main button with the form empty");
  if (ms == null && has(ctx.persona, "silent_failure")) {
    await finding(ctx, "silent_failure", "blocker", c.key, "Clicked the main action with empty fields: nothing happened, no error", c);
  }
  if (!has(ctx.persona, "slow_or_no_confirmation") || !clicked) return;
  await fillForm(ctx.page);
  await arm(ctx.page);
  let again = true;
  try {
    await ctx.page.click(`[data-frl="${c.i}"]`, { timeout: 3000 });
  } catch (e) {
    if (!isTimeout(e)) throw e;
    again = false;
  }
  ctx.steps += 1;
  const ms2 = again ? await watch(ctx.page, ctx.persona.patienceMs) : 0;
  await noteFrame(ctx, "fills the form and clicks again");
  if (ms2 == null) {
    await finding(ctx, "slow_or_no_confirmation", "major", c.key, `No confirmation within ${ctx.persona.patienceMs} ms`, c);
    go(ctx.session, "stuck", "gave up waiting");
  }
}

async function runKeyboard(ctx: Ctx, cs: Control[]): Promise<void> {
  if (!has(ctx.persona, "unreachable_by_keyboard") && !has(ctx.persona, "invisible_focus")) return;
  await ctx.page.evaluate(() => {
    const w = window as unknown as { __frlSeq: number; __frlIds: WeakMap<Element, string> };
    w.__frlSeq = 0;
    w.__frlIds = new WeakMap();
  });
  const seen = new Set<number>();
  const nofocus = new Set<number>();
  let first: string | null = null;
  let last = "";
  let stagnant = 0;
  let tabs = 0;
  for (let n = 0; n < TAB_CAP; n++) {
    await ctx.page.keyboard.press("Tab");
    tabs++;
    const info = await ctx.page.evaluate(() => {
      const w = window as unknown as { __frlSeq: number; __frlIds: WeakMap<Element, string> };
      const e = document.activeElement;
      if (!e || e === document.body || e === document.documentElement) return null;
      if (!w.__frlIds.has(e)) w.__frlIds.set(e, "f" + ++w.__frlSeq);
      const st = getComputedStyle(e);
      const frl = (e as HTMLElement).dataset.frl;
      return {
        i: frl !== undefined && frl !== "" ? Number(frl) : null,
        identity: w.__frlIds.get(e) as string,
        outline: st.outlineStyle !== "none" && st.outlineWidth !== "0px",
        shadow: st.boxShadow !== "none",
      };
    });
    const sig = info ? info.identity : "none";
    stagnant = sig === last ? stagnant + 1 : 0;
    last = sig;
    if (!info) {
      if (stagnant >= 8) break;
      continue;
    }
    const known = info.i !== null && !Number.isNaN(info.i);
    if (first === null) {
      first = info.identity;
      if (known) {
        seen.add(info.i!);
        if (!info.outline && !info.shadow) nofocus.add(info.i!);
      }
    } else if (info.identity === first) {
      break;
    } else if (known) {
      seen.add(info.i!);
      if (!info.outline && !info.shadow) nofocus.add(info.i!);
    }
  }
  ctx.tabs = tabs;
  ctx.steps += 1;
  await noteFrame(ctx, "tabs through the page");
  if (has(ctx.persona, "invisible_focus") && nofocus.size) {
    await finding(ctx, "invisible_focus", "major", "page", `${nofocus.size} controls show no focus ring`);
  }
  if (has(ctx.persona, "unreachable_by_keyboard")) {
    for (const c of cs) {
      if (!seen.has(c.i)) await finding(ctx, "unreachable_by_keyboard", "blocker", c.key, "Control can't be reached with Tab", c);
    }
  }
}

async function runPhone(ctx: Ctx, cs: Control[]): Promise<void> {
  if (!has(ctx.persona, "tiny_tap_target") && !has(ctx.persona, "small_tap_target") && !has(ctx.persona, "horizontal_scroll")) return;
  if (has(ctx.persona, "horizontal_scroll")) {
    const ow = await ctx.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (ow > 4) await finding(ctx, "horizontal_scroll", "minor", "page", `Page is ${ow}px wider than the phone screen`);
  }
  for (const c of cs) {
    if (!c.w || c.tag === "a") continue;
    const m = Math.min(c.w, c.h);
    if (m < 24 && has(ctx.persona, "tiny_tap_target")) {
      await finding(ctx, "tiny_tap_target", "major", c.key, `${Math.trunc(c.w)}x${Math.trunc(c.h)}px, under WCAG 2.5.8's 24px`, c);
    } else if (m < 44 && (c.tag === "button" || c.clickOnly) && has(ctx.persona, "small_tap_target")) {
      await finding(ctx, "small_tap_target", "minor", c.key, `${Math.trunc(c.w)}x${Math.trunc(c.h)}px, under the 44px comfort size`, c);
    }
  }
  ctx.steps += 1;
  await noteFrame(ctx, "checks thumb-size targets");
}

async function runNames(ctx: Ctx, cs: Control[]): Promise<void> {
  if (!has(ctx.persona, "unnamed_control") && !has(ctx.persona, "unlabeled_field") && !has(ctx.persona, "fake_button")) return;
  for (const c of cs) {
    const name = c.name || (c.tag === "a" || c.tag === "button" || c.clickOnly || c.role === "button" ? c.text : "");
    if ((c.tag === "input" || c.tag === "select") && !c.name) {
      if (has(ctx.persona, "unlabeled_field")) {
        await finding(ctx, "unlabeled_field", "major", c.key, "Field has no label (placeholder isn't a label)", c);
      }
    } else if (!/[A-Za-z0-9]/.test(name || "")) {
      if (has(ctx.persona, "unnamed_control")) {
        await finding(ctx, "unnamed_control", "blocker", c.key, "Control has no readable name", c);
      }
    }
    if (c.clickOnly && !c.role && has(ctx.persona, "fake_button")) {
      await finding(ctx, "fake_button", "major", c.key, "Clickable div isn't announced as a button", c);
    }
  }
  ctx.steps += 1;
  await noteFrame(ctx, "listens for control names");
}

async function runLinks(ctx: Ctx, cs: Control[]): Promise<void> {
  if (!has(ctx.persona, "dead_link")) return;
  const links = cs.filter((c) => c.tag === "a" && c.href && !/^(#|mailto:|tel:|javascript:)/i.test(c.href) && isLocal(c, ctx.page.url()));
  for (const c of links.slice(0, ctx.budget)) {
    const abs = new URL(c.href, ctx.page.url()).href;
    const res = await ctx.page.request.get(abs);
    ctx.steps += 1;
    if (res.status() >= 400) await finding(ctx, "dead_link", "major", c.key, `Link returns HTTP ${res.status()}`, c);
  }
  await noteFrame(ctx, "opens every link");
}

async function runPersona(
  browser: Browser,
  persona: Persona,
  url: string,
  opts: { kind: PageKind; budget: number; allow: Set<string>; words: string[]; evidence: boolean; frames: boolean; outDir: string },
  blocked: string[],
  apiFail: string[],
  apiOk: string[],
  pageText: string[],
): Promise<Session> {
  const session = createSession(persona.id);
  go(session, "launching", "start");
  const context = await browser.newContext({
    viewport: { width: persona.viewport.w, height: persona.viewport.h },
    hasTouch: persona.touch,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  const ctx: Ctx = {
    page, session, persona, kind: opts.kind, budget: opts.budget, steps: 0, words: opts.words,
    evidence: opts.evidence, frames: opts.frames, outDir: opts.outDir, tabs: 0,
  };
  try {
    page.on("response", (res) => {
      try {
        const u = new URL(res.url());
        if (!u.pathname.startsWith("/api")) return;
        const line = `${u.pathname} ${res.status()}`;
        (res.status() >= 400 ? apiFail : apiOk).push(line);
      } catch { /* ignore */ }
    });
    await page.route("**/*", async (route) => {
      let host = "";
      try { host = new URL(route.request().url()).hostname; } catch { host = ""; }
      if (host && !opts.allow.has(host)) {
        blocked.push(route.request().url());
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    if (pageText.length === 0) {
      pageText.push(await page.evaluate(() => document.body?.innerText?.slice(0, 20000) || "").catch(() => ""));
    }
    go(session, "exploring", "loaded");
    await noteFrame(ctx, `${persona.label} lands on the page`);
    await dismissOverlays(page);
    const cs = session.state === "exploring" ? await visible(page) : [];
    if (session.state === "exploring") {
      await runSkimmer(ctx, cs);
      if (session.state === "exploring") await runKeyboard(ctx, cs);
      if (session.state === "exploring") await runPhone(ctx, cs);
      if (session.state === "exploring") await runNames(ctx, cs);
      if (session.state === "exploring") await runLinks(ctx, cs);
    }
    session.steps = ctx.steps;
    if (session.state === "exploring") {
      const why = `${ctx.steps} steps` + (ctx.tabs ? `; ${ctx.tabs} tabs` : "");
      go(session, ctx.steps >= opts.budget ? "budget_exhausted" : "done", why);
    } else if (ctx.tabs) {
      const last = session.log[session.log.length - 1];
      if (last && !last.why.includes("tabs")) last.why += `; ${ctx.tabs} tabs`;
    }
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    if (session.state !== "reported" && can(session.state, "crashed")) go(session, "crashed", msg);
  } finally {
    await context.close().catch(() => undefined);
  }
  if (session.state !== "reported" && can(session.state, "reported")) go(session, "reported", "report");
  session.steps = ctx.steps;
  return session;
}

async function detectKind(browser: Browser, url: string, allow: Set<string>): Promise<PageKind> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.route("**/*", async (route) => {
      let host = "";
      try { host = new URL(route.request().url()).hostname; } catch { host = ""; }
      if (host && !allow.has(host)) { await route.abort(); return; }
      await route.continue();
    });
    await page.goto(url, { waitUntil: "load", timeout: 15000 });
    await dismissOverlays(page);
    const n = (await visible(page)).filter((c) => c.tag === "input" || c.tag === "textarea" || c.tag === "select").length;
    return n ? "form" : "dashboard";
  } finally {
    await context.close().catch(() => undefined);
  }
}

function verdictOf(sessions: Session[], hotspots: Run["hotspots"]): Run["verdict"] {
  const crashed = sessions.filter((s) => preReport(s) === "crashed").map((s) => s.persona);
  if (crashed.length) return { kind: "inconclusive", crashed };
  return { kind: "scored", score: scoreHotspots(hotspots) };
}

export async function executeRun(opts: RunOptions): Promise<Run> {
  const allow = new Set(["127.0.0.1", "localhost", ...(opts.allow || [])]);
  assertLocal(opts.url, allow);
  const budget = opts.budget ?? 12;
  const words = redactWords(opts.redact);
  const evidence = opts.evidence !== false;
  const frames = opts.frames === true;
  const write = opts.write !== false;
  const id = opts.id || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let htmlSource = "";
  let status: number | string = 0;
  try {
    const res = await fetch(opts.url);
    status = res.status;
    htmlSource = await res.text();
  } catch (e) {
    status = e instanceof Error ? e.message.slice(0, 60) : "error";
  }
  const earlyHits = privacyHits(htmlSource);
  if (earlyHits.length) throw new PrivacyError(earlyHits);
  const startedAt = new Date().toISOString();
  const base: Omit<Run, "verdict" | "hotspots" | "sessions" | "kind"> = {
    schema: 1, id, url: opts.url, startedAt, blocked: [],
  };
  if (status !== 200) {
    const run: Run = {
      ...base, kind: "form", sessions: [], hotspots: [], blocked: [],
      verdict: { kind: "unreachable", detail: `landing page returned ${status}` },
    };
    if (write && opts.out) await publish(run, opts.out, htmlSource, words);
    return run;
  }

  let browser = opts.browser;
  const launched = !browser;
  if (!browser) browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const tmp = mkdtempSync(join(tmpdir(), "frl-"));
  const blocked: string[] = [];
  const apiFail: string[] = [];
  const apiOk: string[] = [];
  const pageText: string[] = [];
  try {
    let kind: PageKind = "form";
    try {
      kind = !opts.kind || opts.kind === "auto" ? await detectKind(browser, opts.url, allow) : opts.kind;
    } catch {
      kind = "form";
    }
    const personas = selectPersonas(opts.personas, opts.personaDir);
    const sessions: Session[] = [];
    for (const persona of personas) {
      const session = await runPersona(browser, persona, opts.url, {
        kind, budget, allow, words, evidence, frames, outDir: tmp,
      }, blocked, apiFail, apiOk, pageText);
      sessions.push(session);
    }
    const text = pageText.join("\n");
    const fails = [...new Set(apiFail)];
    const ok = apiOk.length > 0;
    if (fails.length && ok) {
      const skimmer = sessions.find((s) => s.persona === "skimmer") || sessions[0];
      if (skimmer) {
        for (const a of fails) {
          const [path, code] = a.split(" ");
          skimmer.findings.push({
            persona: skimmer.persona,
            kind: "broken_api",
            severity: "major",
            control: applyRedact(path, words),
            detail: applyRedact(`App's own API returned ${code}`, words),
            evidence: { shot: "" },
            step: skimmer.steps,
          });
        }
      }
      fails.length = 0;
    }
    if (fails.length) {
      const run: Run = {
        ...base, kind, sessions, hotspots: [], blocked: [...new Set(blocked)],
        verdict: { kind: "needs_backend", detail: fails.slice(0, 3).join(", ") },
      };
      if (write && opts.out) await publish(run, opts.out, htmlSource + text, words, tmp);
      else rmSync(tmp, { recursive: true, force: true });
      return run;
    }
    const hotspots = merge(sessions);
    const run: Run = {
      ...base, kind, sessions, hotspots, blocked: [...new Set(blocked)],
      verdict: verdictOf(sessions, hotspots),
    };
    if (write && opts.out) await publish(run, opts.out, htmlSource + text, words, tmp);
    else rmSync(tmp, { recursive: true, force: true });
    return run;
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    if (launched) await browser.close().catch(() => undefined);
  }
}

async function publish(run: Run, out: string, extra: string, words: string[], tmp?: string): Promise<void> {
  const report = renderReport(run);
  const hits = privacyHits(JSON.stringify(run) + report + extra);
  if (hits.length) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    throw new PrivacyError(hits);
  }
  mkdirSync(dirname(out), { recursive: true });
  if (tmp) {
    mkdirSync(join(tmp, "shots"), { recursive: true });
    writeFileSync(join(tmp, "run.json"), JSON.stringify(run, null, 2));
    writeFileSync(join(tmp, "report.html"), report);
    rmSync(out, { recursive: true, force: true });
    renameSync(tmp, out);
  } else {
    mkdirSync(out, { recursive: true });
    const file = join(out, "run.json");
    const partial = file + ".partial";
    writeFileSync(partial, JSON.stringify(run, null, 2));
    renameSync(partial, file);
    writeFileSync(join(out, "report.html"), report);
  }
  void words;
}

export function loadRun(dirOrFile: string): Run {
  const file = dirOrFile.endsWith(".json") ? dirOrFile : join(dirOrFile, "run.json");
  return JSON.parse(readFileSync(file, "utf8")) as Run;
}
