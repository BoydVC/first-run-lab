import type { FindingKind, Hotspot, Run, Severity } from "./types.js";

export const SEV_RANK: Record<Severity, number> = { blocker: 3, major: 2, minor: 1 };

/** Highest-severity kind first (spec O9). */
export const KIND_ORDER: FindingKind[] = [
  "silent_failure",
  "unreachable_by_keyboard",
  "unnamed_control",
  "unclickable_cta",
  "fake_button",
  "dead_link",
  "broken_api",
  "unlabeled_field",
  "tiny_tap_target",
  "slow_or_no_confirmation",
  "invisible_focus",
  "no_clear_cta",
  "small_tap_target",
  "horizontal_scroll",
];

export const KIND_LABEL: Record<FindingKind, string> = {
  no_clear_cta: "No clear action",
  silent_failure: "Silent failure",
  slow_or_no_confirmation: "Slow or missing confirmation",
  unreachable_by_keyboard: "Unreachable by keyboard",
  invisible_focus: "Invisible focus",
  tiny_tap_target: "Tiny tap target",
  small_tap_target: "Small tap target",
  horizontal_scroll: "Horizontal scroll",
  unnamed_control: "Unnamed control",
  unlabeled_field: "Unlabeled field",
  fake_button: "Fake button",
  dead_link: "Dead link",
  unclickable_cta: "Unclickable action",
  broken_api: "Broken API",
};

/** One line per finding kind. Shown on the report and under the top hotspot in the terminal. */
export const FIX: Record<FindingKind, string> = {
  no_clear_cta: "Add one obvious button that says what happens next.",
  silent_failure: "When the action can't finish, say what's missing in an alert.",
  slow_or_no_confirmation: "Show a confirmation within a couple of seconds.",
  unreachable_by_keyboard: "Make it a real button or link, or give it tabindex 0.",
  invisible_focus: "Keep a visible focus ring. Don't set outline to none.",
  tiny_tap_target: "Make the control at least 24 by 24 pixels (WCAG 2.5.8).",
  small_tap_target: "Give buttons at least 44 by 44 pixels so a thumb can land.",
  horizontal_scroll: "Let the layout reflow inside a phone width.",
  unnamed_control: "Give the control a name: visible text or an aria-label.",
  unlabeled_field: "Add a label element. A placeholder is not a label.",
  fake_button: "Use a button element, or add role=button and keyboard support.",
  dead_link: "Point the link at a page on this site that returns HTTP 200.",
  unclickable_cta: "Remove whatever covers the main action so it can be clicked.",
  broken_api: "Fix the failing API call, or show the error in the page.",
};

export function displayKinds(kinds: FindingKind[]): FindingKind[] {
  return [...kinds].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
}

export function primaryKind(kinds: FindingKind[]): FindingKind {
  return displayKinds(kinds)[0] ?? "no_clear_cta";
}

export function experienceSentence(control: string, kind: FindingKind): string {
  const name = control === "page" ? "the page" : control;
  switch (kind) {
    case "silent_failure":
      return `Clicked ${name} and nothing happened — no error and no next step.`;
    case "slow_or_no_confirmation":
      return `After ${name}, nothing confirmed the step within a couple of seconds.`;
    case "no_clear_cta":
      return "Scanned the page and couldn't tell what a first-timer is supposed to do.";
    case "unreachable_by_keyboard":
      return `Tabbed through the page and never landed on ${name}.`;
    case "invisible_focus":
      return "Moved focus with the keyboard, but the page didn't show where it was.";
    case "tiny_tap_target":
      return `${name} is smaller than 24 pixels, under the WCAG tap-target limit.`;
    case "small_tap_target":
      return `${name} is under 44 pixels, a tight target for a thumb.`;
    case "horizontal_scroll":
      return "The page is wider than the phone, so part of it sits off to the side.";
    case "unnamed_control":
      return `Reached ${name} and heard no name for it.`;
    case "unlabeled_field":
      return `The ${name} field has no label. A placeholder doesn't count.`;
    case "fake_button":
      return `${name} acts like a button, but it's a clickable div a screen reader won't announce as one.`;
    case "dead_link":
      return `Opened ${name} and got an error instead of a page.`;
    case "unclickable_cta":
      return `Tried to click ${name}, but something was covering it.`;
    case "broken_api":
      return `The page called ${name} and the app's own API failed.`;
    default:
      return `Got stuck on ${name}.`;
  }
}

export function headline(run: Run): string {
  if (run.verdict.kind === "inconclusive") {
    const who = run.verdict.crashed.join(", ");
    return `Inconclusive — ${who} crashed, so this run is not a pass`;
  }
  if (run.verdict.kind === "unreachable") return `Unreachable — ${run.verdict.detail}`;
  if (run.verdict.kind === "needs_backend") return `Needs a backend — ${run.verdict.detail}`;
  if (run.hotspots.length === 0) return `All ${run.sessions.length} first-time users got through`;
  const top = run.hotspots[0];
  const name = top.control === "page" ? "This page" : top.control;
  return `${name} tripped up ${top.personas.length} of ${run.sessions.length} first-time users`;
}

export function formatTerminal(run: Run, reportPath: string): string {
  const lines: string[] = ["First-Run Lab", "", headline(run), ""];
  if (run.verdict.kind === "scored") lines.push(`  score   ${run.verdict.score} / 100`);
  else if (run.verdict.kind === "inconclusive") lines.push("  score   Inconclusive");
  else if (run.verdict.kind === "unreachable") lines.push("  score   Unreachable");
  else lines.push("  score   Needs a backend");
  lines.push(`  url     ${run.url}`, "");
  if (run.verdict.kind === "inconclusive") {
    lines.push("  The score dial is grey because a first-time user crashed. A crashed run is not a pass.", "");
  }
  const total = run.sessions.length || 5;
  for (const h of run.hotspots) {
    const kind = primaryKind(h.kinds);
    lines.push(`  ${h.severity.padEnd(8)} ${h.control}    ${h.personas.length} of ${total}`);
    lines.push(`           ${experienceSentence(h.control, kind)}`);
    for (const k of displayKinds(h.kinds)) lines.push(`           Fix: ${FIX[k]}`);
    lines.push("");
  }
  if (reportPath && run.verdict.kind !== "unreachable") lines.push(`  report  ${reportPath}`);
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export function hotspotSentence(h: Hotspot): string {
  return experienceSentence(h.control, primaryKind(h.kinds));
}
