import type { Box, ControlKey, PageKind } from "./types.js";

export interface Control {
  index: number;
  tag: string;
  text: string;
  name: string;
  placeholder: string;
  role: string;
  key: ControlKey;
  href: string;
  visible: boolean;
  clickOnly: boolean;
  type: string;
  box: Box;
}

export interface SkimmerObs {
  cta: ControlKey | null;
  unclickable: boolean;
  emptyMs: number | null;
  filledMs: number | null;
  secondSkipped: boolean;
}

export interface KeyboardObs {
  reached: readonly number[];
  noFocus: readonly number[];
  tabs: number;
}

export interface LinkObs {
  index: number;
  status: number;
}

export interface PageSnapshot {
  url: string;
  kind: PageKind;
  controls: readonly Control[];
  overflowPx: number;
  redact: readonly string[];
  skimmer?: SkimmerObs;
  keyboard?: KeyboardObs;
  links?: readonly LinkObs[];
  brokenApis?: readonly { path: string; status: number }[];
}

export const TAB_CAP = 500;

const CTA = /\b(sign|start|join|submit|buy|go|add|save|create|new|play|begin|plan|calculate|search|send)\b/i;
const UTILITY = /export|download|print|reset|delete|clear|import|copy|help/i;
const SKIP_HREF = /^(#|mailto:|tel:|javascript:)/i;

export function isLocalLink(control: Control, pageUrl: string): boolean {
  if (control.tag !== "a" || !control.href) return true;
  let abs: URL;
  try {
    abs = new URL(control.href, pageUrl);
  } catch {
    return true;
  }
  let here: URL;
  try {
    here = new URL(pageUrl);
  } catch {
    return false;
  }
  return abs.hostname === here.hostname;
}

export function pickCta(controls: readonly Control[], pageUrl: string): Control | null {
  for (const control of controls) {
    if (!control.visible) continue;
    if (!isLocalLink(control, pageUrl)) continue;
    const interactive =
      control.tag === "button" || control.tag === "a" || control.role === "button" || control.clickOnly;
    if (!interactive) continue;
    const blob = `${control.text}${control.name}`;
    if (UTILITY.test(blob)) continue;
    if (CTA.test(blob)) return control;
  }
  return null;
}

export function linksToCheck(controls: readonly Control[], pageUrl: string, budget: number): Control[] {
  const out: Control[] = [];
  for (const control of controls) {
    if (!control.visible || control.tag !== "a" || !control.href) continue;
    if (SKIP_HREF.test(control.href)) continue;
    if (!isLocalLink(control, pageUrl)) continue;
    out.push(control);
    if (out.length >= budget) break;
  }
  return out;
}
