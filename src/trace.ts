import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Clock } from "./clock.ts";

// The brief asks for exactly these five labels. Anything more specific (a policy refusal,
// a budget stop, a staleness halt) goes in `kind`, so the label set stays small and auditable.
export type TraceLabel = "reasoning" | "asking" | "proposing" | "confirmed" | "executed";

// Which stage of Understand -> Reason -> Ask -> Use tools -> Recommend -> Reassess produced the step.
export type Phase = "understand" | "reason" | "ask" | "use_tools" | "recommend" | "reassess";

export interface TraceStep {
  step: number;
  label: TraceLabel;
  phase: Phase;
  kind: string;
  at: string;
  summary: string;
  detail?: unknown;
}

export class Trace {
  readonly runId: string;
  sid: string;
  readonly steps: TraceStep[] = [];
  private clock: Clock;
  private onStep?: (s: TraceStep) => void;

  constructor(runId: string, sid: string, clock: Clock, onStep?: (s: TraceStep) => void) {
    this.runId = runId;
    this.sid = sid;
    this.clock = clock;
    this.onStep = onStep;
  }

  add(label: TraceLabel, phase: Phase, kind: string, summary: string, detail?: unknown): TraceStep {
    const s: TraceStep = {
      step: this.steps.length + 1,
      label,
      phase,
      kind,
      at: this.clock.now().toISOString(),
      summary,
      ...(detail === undefined ? {} : { detail }),
    };
    this.steps.push(s);
    this.onStep?.(s);
    return s;
  }

  toJSON() {
    return { runId: this.runId, situationId: this.sid, steps: this.steps };
  }

  save(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.toJSON(), null, 2) + "\n", "utf8");
  }
}

/** Drafts saved during a run, read back from their trace steps (so any saved trace can show them). */
export function draftsIn(steps: TraceStep[]): { draftId: string; recipient: string; channel: string; subject?: string; body: string }[] {
  return steps
    .filter((s) => s.kind === "draft_saved" && s.detail)
    .map((s) => s.detail as { draftId: string; recipient: string; channel: string; subject?: string; body: string });
}
