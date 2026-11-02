import { assertSession, type SessionState } from "./statechart.generated.ts";
import type { Finding, Frame, Persona, Transition } from "./types.ts";

export class Session {
  persona: Persona;
  state: SessionState = "queued";
  log: Transition[] = [];
  findings: Finding[] = [];
  frames: Frame[] = [];
  steps = 0;
  error?: string;
  apiFail: string[] = [];
  apiOk: string[] = [];
  private t0 = Date.now();

  constructor(persona: Persona) {
    this.persona = persona;
  }

  go(to: SessionState, why: string): void {
    assertSession(this.state, to, why);
    this.log.push({ from: this.state, to, why, atMs: Date.now() - this.t0 });
    this.state = to;
  }
}
