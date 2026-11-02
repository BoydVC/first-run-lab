/**
 * Browser driver. It records a PageSnapshot, then personaFindings() judges it.
 * Closed <details> and collapsed accordions are not visible controls.
 * Keyboard tabbing continues until focus wraps, capped at TAB_CAP.
 */
import type { Browser, Page } from "playwright";
import { personaFindings } from "./personas.js";
import {
  TAB_CAP,
  isLocalLink,
  linksToCheck,
  pickCta,
  type Control,
  type KeyboardObs,
  type LinkObs,
  type PageSnapshot,
  type SkimmerObs,
} from "./snapshot.js";
import { apply, createSession } from "./statechart.js";
import {
  controlKey,
  type Frame,
  type PageKind,
  type Persona,
  type Session,
} from "./types.js";

const COLLECT_JS = `(() => {
  const nodes = [...document.querySelectorAll("a,button,input,select,textarea,[onclick],[role=button]")];
  const closed = (el) => {
    const details = el.closest("details");
    if (details && !details.open && !el.closest("summary")) return true;
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.hasAttribute("hidden")) return true;
      if (node.getAttribute("aria-hidden") === "true") return true;
      const id = node.id;
      if (id) {
        const trigger = document.querySelector('[aria-controls="' + CSS.escape(id) + '"]');
        if (trigger && trigger.getAttribute("aria-expanded") === "false") return true;
      }
      const style = getComputedStyle(node);
      const clips = ["hidden", "clip"].includes(style.overflow) || ["hidden", "clip"].includes(style.overflowY) || ["hidden", "clip"].includes(style.overflowX);
      if (clips) {
        const box = node.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) return true;
      }
      node = node.parentElement;
    }
    return false;
  };
  return nodes.map((e, i) => {
    e.dataset.frl = String(i);
    const r = e.getBoundingClientRect();
    const tag = e.tagName.toLowerCase();
    const lab = e.labels && e.labels.length ? e.labels[0].innerText : "";
    const aria = e.getAttribute("aria-label") || "";
    const placeholder = e.getAttribute("placeholder") || "";
    const title = e.getAttribute("title") || "";
    const role = e.getAttribute("role") || "";
    const text = ((e.innerText || e.value || "") + "").trim().slice(0, 40);
    const rawKey = (aria || lab || placeholder || (tag === "select" ? "" : (e.innerText || "")) || e.id || e.tagName)
      .trim().split(String.fromCharCode(10))[0].slice(0, 30);
    const style = getComputedStyle(e);
    const vis = !!(e.offsetParent || e.getClientRects().length) && (!e.checkVisibility || e.checkVisibility())
      && r.width > 0 && r.height > 0
      && style.visibility !== "hidden" && !e.disabled
      && !e.closest("[aria-hidden=true],[inert],dialog:not([open])")
      && !closed(e);
    const clickOnly = e.hasAttribute("onclick") && !["a", "button", "input", "select"].includes(tag);
    return {
      i, tag, text, name: (aria || lab || title).trim(), placeholder, role, key: rawKey,
      href: e.getAttribute("href") || "", vis, clickOnly,
      type: (e.getAttribute("type") || "").toLowerCase(),
      x: r.x, y: r.y, w: r.width, h: r.height, tabIndex: e.tabIndex
    };
  });
})()`;

const FOCUS_JS = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body || e === document.documentElement) return null;
  if (!e.dataset.frlUid) {
    window.__frlSeq = (window.__frlSeq || 0) + 1;
    e.dataset.frlUid = String(window.__frlSeq);
  }
  const st = getComputedStyle(e);
  return {
    uid: e.dataset.frlUid,
    frl: e.dataset.frl == null || e.dataset.frl === "" ? null : e.dataset.frl,
    outline: st.outlineStyle !== "none" && st.outlineWidth !== "0px",
    shadow: st.boxShadow !== "none"
  };
})()`;

const ARM_JS = `(() => {
  window.__frlFb = 0;
  window.__frlUrl = location.href;
  if (window.__frlObs) window.__frlObs.disconnect();
  window.__frlObs = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target && (target.closest("[role=alert],[role=status],[aria-live]") || target.offsetParent !== null || target.getClientRects().length)) {
        window.__frlFb++;
      }
    }
  });
  window.__frlObs.observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["style", "class", "hidden", "aria-invalid"]
  });
  window.__frlCv = () => [...document.querySelectorAll("canvas")].map((canvas) => {
    try {
      const data = canvas.toDataURL();
      let hash = 0;
      for (let i = 0; i < data.length; i += 7) hash = (hash * 31 + data.charCodeAt(i)) | 0;
      return hash;
    } catch (err) { return 0; }
  }).join(",");
  window.__frlCv0 = window.__frlCv();
  window.__frlF0 = document.activeElement;
})()`;

const WATCH_JS = `(() => {
  const active = document.activeElement;
  const moved = !!(active && active !== window.__frlF0 && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  return window.__frlFb > 0 || location.href !== window.__frlUrl || !!document.querySelector(":invalid:focus")
    || window.__frlCv() !== window.__frlCv0 || moved;
})()`;

const SKIP_INPUT = new Set(["checkbox", "radio", "file", "range", "color", "submit", "button", "hidden", "image", "reset"]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseControls(raw: unknown): Control[] {
  if (!Array.isArray(raw)) throw new Error("control list was not an array");
  return raw.map((item) => {
    if (!isRecord(item)) throw new Error("control was not an object");
    return {
      index: num(item.i),
      tag: str(item.tag),
      text: str(item.text),
      name: str(item.name),
      placeholder: str(item.placeholder),
      role: str(item.role),
      key: controlKey(str(item.key)),
      href: str(item.href),
      visible: item.vis === true,
      clickOnly: item.clickOnly === true,
      type: str(item.type),
      box: { x: num(item.x), y: num(item.y), w: num(item.w), h: num(item.h) },
    };
  });
}

async function evalUnknown(page: Page, script: string): Promise<unknown> {
  return page.evaluate(script);
}

export async function collectControls(page: Page): Promise<Control[]> {
  return parseControls(await evalUnknown(page, COLLECT_JS));
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /Timeout/i.test(error.message);
}

function isNavigation(error: unknown): boolean {
  return error instanceof Error && /destroyed|navigation|target closed/i.test(error.message);
}

async function arm(page: Page): Promise<void> {
  await evalUnknown(page, ARM_JS);
}

async function watch(page: Page, patienceMs: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < patienceMs) {
    try {
      const hit = await evalUnknown(page, WATCH_JS);
      if (hit === true) return Date.now() - started;
    } catch (error) {
      if (isNavigation(error) || error instanceof Error) return Date.now() - started;
    }
    await page.waitForTimeout(100);
  }
  return null;
}

const FILL_PASSES = 3;

async function fillOne(page: Page, control: Control, sel: string): Promise<void> {
  if (control.tag === "select") {
    const countRaw = await evalUnknown(
      page,
      `(() => document.querySelector(${JSON.stringify(sel)})?.options?.length ?? 0)()`,
    );
    const count = typeof countRaw === "number" ? countRaw : 0;
    if (count > 0) await page.selectOption(sel, { index: Math.min(1, count - 1) }, { timeout: 2000 });
    return;
  }
  const type = control.type || "text";
  const value = Object.prototype.hasOwnProperty.call(SYNTH, type)
    ? SYNTH[type] ?? ""
    : SKIP_INPUT.has(type)
      ? ""
      : "Test Visitor";
  if (!value) return;
  await page.fill(sel, value, { timeout: 2000 });
}

/**
 * Fill every visible field. A page may re-draw inputs while we type (a select
 * that rebuilds the fields under it). When a field vanishes, re-query and carry
 * on, up to FILL_PASSES. If it is still being re-drawn, report that instead of
 * crashing the persona.
 */
async function fillForm(page: Page): Promise<Control["key"] | null> {
  const done = new Set<string>();
  let last: Control | null = null;
  for (let pass = 0; pass < FILL_PASSES; pass += 1) {
    const controls = await collectControls(page);
    let redrawn = false;
    const seen = new Map<string, number>();
    for (const control of controls) {
      if (!control.visible) continue;
      if (control.tag !== "input" && control.tag !== "textarea" && control.tag !== "select") continue;
      const base = `${control.tag}:${control.key}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const ident = `${base}#${n}`;
      if (done.has(ident)) continue;
      const sel = `[data-frl="${control.index}"]`;
      try {
        await fillOne(page, control, sel);
        done.add(ident);
      } catch {
        const still = await evalUnknown(page, `(() => !!document.querySelector(${JSON.stringify(sel)}))()`);
        if (still === true) done.add(ident);
        else {
          redrawn = true;
          last = control;
          break;
        }
      }
    }
    if (!redrawn) return null;
  }
  return last?.key ?? controlKey("field");
}

async function dismissOverlays(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const controls = await collectControls(page);
  for (const control of controls) {
    if (!control.visible) continue;
    if (!/^\s*(got it|close|dismiss|ok|okay|skip|×|✕|continue)\s*!?$/i.test(control.text || control.name)) continue;
    const inside = await evalUnknown(
      page,
      `(() => !!document.querySelector("[data-frl='${control.index}']")?.closest("dialog,[role=dialog],[aria-modal=true],.modal,.overlay,.help"))()`,
    );
    if (inside === true) {
      try {
        await page.click(`[data-frl="${control.index}"]`, { timeout: 2000 });
        await page.waitForTimeout(150);
      } catch {
        /* overlay already gone */
      }
      return;
    }
  }
}

async function observeSkimmer(page: Page, persona: Persona, controls: readonly Control[], pageUrl: string): Promise<{ obs: SkimmerObs; steps: number; captions: string[] }> {
  const cta = pickCta(controls, pageUrl);
  if (!cta) {
    return {
      obs: { cta: null, unclickable: false, emptyMs: null, filledMs: null, secondSkipped: true, redrawKey: null },
      steps: 0,
      captions: [],
    };
  }
  const sel = `[data-frl="${cta.index}"]`;
  await arm(page);
  try {
    await page.click(sel, { timeout: 3000 });
  } catch (error) {
    if (!isTimeout(error)) throw error;
    return {
      obs: { cta: cta.key, unclickable: true, emptyMs: null, filledMs: null, secondSkipped: true, redrawKey: null },
      steps: 1,
      captions: [],
    };
  }
  const emptyMs = await watch(page, persona.patienceMs);
  const redrawKey = await fillForm(page);
  await arm(page);
  let secondSkipped = false;
  try {
    await page.click(sel, { timeout: 3000 });
  } catch (error) {
    if (!isTimeout(error) && !isNavigation(error)) throw error;
    secondSkipped = true;
  }
  const filledMs = secondSkipped ? 0 : await watch(page, persona.patienceMs);
  return {
    obs: { cta: cta.key, unclickable: false, emptyMs, filledMs, secondSkipped, redrawKey },
    steps: 2,
    captions: ["clicks the main button with the form empty", "fills the form, clicks again"],
  };
}

interface FocusInfo {
  uid: string;
  frl: string | null;
  outline: boolean;
  shadow: boolean;
}

function parseFocus(raw: unknown): FocusInfo | null {
  if (!isRecord(raw)) return null;
  const uid = str(raw.uid);
  if (!uid) return null;
  return { uid, frl: raw.frl === null ? null : str(raw.frl) || null, outline: raw.outline === true, shadow: raw.shadow === true };
}

async function observeKeyboard(page: Page): Promise<KeyboardObs> {
  const reached = new Set<number>();
  const noFocus = new Set<number>();
  let first: string | null = null;
  let left = false;
  let tabs = 0;
  for (let i = 0; i < TAB_CAP; i += 1) {
    await page.keyboard.press("Tab");
    tabs = i + 1;
    let info: FocusInfo | null = null;
    try {
      info = parseFocus(await evalUnknown(page, FOCUS_JS));
    } catch (error) {
      if (isNavigation(error)) break;
      throw error;
    }
    if (!info) continue;
    if (first === null) first = info.uid;
    else if (info.uid === first && left) break;
    if (info.uid !== first) left = true;
    if (info.frl === null) continue;
    const index = Number(info.frl);
    if (!Number.isInteger(index)) continue;
    reached.add(index);
    if (!info.outline && !info.shadow) noFocus.add(index);
  }
  return { reached: [...reached], noFocus: [...noFocus], tabs };
}

async function observeLinks(page: Page, controls: readonly Control[], pageUrl: string, budget: number): Promise<LinkObs[]> {
  const out: LinkObs[] = [];
  for (const control of linksToCheck(controls, pageUrl, budget)) {
    if (!isLocalLink(control, pageUrl)) continue;
    const target = new URL(control.href, pageUrl);
    try {
      const response = await page.request.get(target.href, { timeout: 8000 });
      out.push({ index: control.index, status: response.status() });
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0]?.slice(0, 80) ?? "request failed" : "request failed";
      out.push({ index: control.index, status: 0, error: message });
    }
  }
  return out;
}

function wants(persona: Persona, kinds: readonly string[]): boolean {
  return persona.checks.some((kind) => kinds.includes(kind));
}

export interface DriveResult {
  findings: Session["findings"];
  steps: number;
  frames: Frame[];
  controls: Control[];
}

async function shoot(page: Page, outDir: string | null, persona: Persona, frames: Frame[], caption: string): Promise<void> {
  const shot = `frames/${persona.id}-${String(frames.length).padStart(2, "0")}.png`;
  if (outDir) {
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(outDir, "frames"), { recursive: true });
    await page.screenshot({ path: join(outDir, shot) });
  }
  frames.push({ shot: outDir ? shot : "", caption });
}

export async function drivePersona(
  page: Page,
  persona: Persona,
  kind: PageKind,
  budget: number,
  redact: readonly string[],
  outDir: string | null,
): Promise<DriveResult> {
  const frames: Frame[] = [];
  await dismissOverlays(page);
  await shoot(page, outDir, persona, frames, `${persona.label}: lands on the page`);
  const controls = await collectControls(page);
  const overflowRaw = await evalUnknown(page, "document.documentElement.scrollWidth - window.innerWidth");
  const overflowPx = typeof overflowRaw === "number" ? Math.trunc(overflowRaw) : 0;
  let steps = 0;
  const snapshot: PageSnapshot = { url: page.url(), kind, controls, overflowPx, redact };
  if (wants(persona, ["no_clear_cta", "silent_failure", "slow_or_no_confirmation", "unclickable_cta"])) {
    const skim = await observeSkimmer(page, persona, controls, page.url());
    snapshot.skimmer = skim.obs;
    steps += skim.steps;
    if (skim.captions[0]) await shoot(page, outDir, persona, frames, skim.captions[0]);
    if (skim.captions[1]) await shoot(page, outDir, persona, frames, skim.captions[1]);
  }
  if (wants(persona, ["unreachable_by_keyboard", "invisible_focus"])) {
    snapshot.keyboard = await observeKeyboard(page);
    steps += 1;
    await shoot(page, outDir, persona, frames, `tabs through the page (${snapshot.keyboard.tabs})`);
  }
  if (wants(persona, ["tiny_tap_target", "small_tap_target", "horizontal_scroll"])) {
    steps += 1;
    await shoot(page, outDir, persona, frames, "checks thumb-size targets");
  }
  if (wants(persona, ["unnamed_control", "unlabeled_field", "fake_button"])) {
    steps += 1;
    await shoot(page, outDir, persona, frames, "listens for control names");
  }
  if (wants(persona, ["dead_link"])) {
    snapshot.links = await observeLinks(page, controls, page.url(), budget);
    steps += snapshot.links.length;
    await shoot(page, outDir, persona, frames, "opens every link");
  }
  const findings = personaFindings(snapshot, persona);
  if (outDir) {
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(outDir, "shots"), { recursive: true });
    for (const finding of findings) {
      if (!finding.evidence.box) continue;
      const pad = 8;
      const clip = {
        x: Math.max(0, finding.evidence.box.x - pad),
        y: Math.max(0, finding.evidence.box.y - pad),
        width: Math.max(1, finding.evidence.box.w + pad * 2),
        height: Math.max(1, finding.evidence.box.h + pad * 2),
      };
      try {
        await page.screenshot({ path: join(outDir, finding.evidence.shot), clip });
      } catch {
        await page.screenshot({ path: join(outDir, finding.evidence.shot) });
      }
    }
  }
  return { findings, steps, frames, controls };
}

export async function runSession(
  browser: Browser,
  persona: Persona,
  url: string,
  opts: {
    kind: PageKind;
    budget: number;
    redact: readonly string[];
    allow: ReadonlySet<string>;
    screenshots: boolean;
    outDir: string | null;
    blocked: string[];
  },
): Promise<Session & { apiFail: string[]; apiOk: string[] }> {
  const started = Date.now();
  const now = (): number => Date.now() - started;
  let session = apply(createSession(persona.id), "launching", "start", now());
  const context = await browser.newContext({
    viewport: { width: persona.viewport.w, height: persona.viewport.h },
    hasTouch: persona.touch,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(8000);
  const apiFail: string[] = [];
  const apiOk: string[] = [];
  page.on("response", (response) => {
    try {
      const target = new URL(response.url());
      if (!target.pathname.startsWith("/api")) return;
      const line = `${target.pathname} ${response.status()}`;
      if (response.status() >= 400) apiFail.push(line);
      else apiOk.push(line);
    } catch {
      /* ignore malformed urls */
    }
  });
  try {
    await page.route("**/*", async (route) => {
      const target = route.request().url();
      if (hostAllowed(target, opts.allow)) {
        await route.continue();
        return;
      }
      opts.blocked.push(target);
      await route.abort();
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => undefined);
    session = apply(session, "exploring", "loaded", now());
    if (new URL(page.url()).searchParams.get("frl_inject") === "evaluate-error") {
      await evalUnknown(page, "(() => { throw new Error('injected evaluate error'); })()");
    }
    const driven = await drivePersona(page, persona, opts.kind, opts.budget, opts.redact, opts.screenshots ? opts.outDir : null);
    for (let i = 0; i < driven.steps; i += 1) session = apply(session, "exploring", "step", now());
    session = { ...session, findings: driven.findings, frames: driven.frames };
    const gaveUp = session.findings.some((finding) => finding.kind === "unclickable_cta")
      ? "main action unclickable"
      : session.findings.some((finding) => finding.kind === "slow_or_no_confirmation")
        ? "gave up waiting"
        : null;
    if (gaveUp) session = apply(session, "stuck", gaveUp, now());
    else if (session.steps >= opts.budget) session = apply(session, "budget_exhausted", `${session.steps} steps`, now());
    else session = apply(session, "done", `${session.steps} steps`, now());
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "error";
    if (session.state === "launching" || session.state === "exploring") {
      session = apply(session, "crashed", message, now());
    }
  } finally {
    await context.close();
  }
  if (session.state !== "reported") session = apply(session, "reported", "report", now());
  return { ...session, apiFail, apiOk };
}

export function hostAllowed(rawUrl: string, allow: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "about:") return true;
  return allow.has(parsed.hostname);
}

export class TargetRefusedError extends Error {
  readonly exitCode = 64;
  constructor(host: string) {
    super(`refusing ${host}: only localhost targets are allowed (refused before browser launch)`);
    this.name = "TargetRefusedError";
  }
}

export function assertLocalUrl(url: string, allow: ReadonlySet<string>): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TargetRefusedError(url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TargetRefusedError(parsed.protocol);
  if (!allow.has(parsed.hostname)) throw new TargetRefusedError(parsed.hostname);
}

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  const bundled = process.env.FRL_CHROMIUM;
  if (bundled) return chromium.launch({ executablePath: bundled, args });
  const cached = "/home/ubuntu/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
  const { existsSync } = await import("node:fs");
  if (existsSync(cached)) return chromium.launch({ executablePath: cached, args });
  try {
    return await chromium.launch({ channel: "chrome", args });
  } catch {
    return chromium.launch({ args });
  }
}

export async function detectKind(browser: Browser, url: string, allow: ReadonlySet<string>): Promise<PageKind> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.route("**/*", async (route) => {
      if (hostAllowed(route.request().url(), allow)) await route.continue();
      else await route.abort();
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissOverlays(page);
    const controls = await collectControls(page);
    const fields = controls.filter((control) => control.visible && ["input", "textarea", "select"].includes(control.tag));
    return fields.length > 0 ? "form" : "dashboard";
  } finally {
    await context.close();
  }
}
