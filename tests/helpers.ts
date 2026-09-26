import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextStepAgent } from "../src/agent.ts";
import { FakeClock } from "../src/clock.ts";
import { Faults } from "../src/faults.ts";
import { ScriptedModel, fakeMessage } from "../src/model.ts";
import type { Assessment } from "../src/priority.ts";
import { SituationStore } from "../src/store.ts";
import { MockOutbox } from "../src/tools/sendMessage.ts";

export function env(start = "2026-09-26T20:00:00+05:30", turns: ConstructorParameters<typeof ScriptedModel>[0] = [], maxToolCalls?: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "nextstep-"));
  const clock = new FakeClock(start);
  const store = new SituationStore(dir, clock);
  const outbox = new MockOutbox(dir);
  const faults = new Faults();
  const model = new ScriptedModel(turns);
  const agent = new NextStepAgent({ store, model, outbox, faults, maxToolCalls });
  return { dir, clock, store, outbox, faults, model, agent };
}

export function assessment(over: Partial<Assessment> = {}): Assessment {
  return {
    language: "English",
    request_type: "situation_help",
    risk_level: "none",
    risk_signals: [],
    problems: [{ id: "p1", title: "Reply to manager", category: "work", urgency: "high", deadline_text: null, facts: ["manager angry", "HR cc'd"] }],
    contradictions: [],
    missing_info: [],
    untrusted_instructions_seen: [],
    top_priority: { problem_id: "p1", next_action: "draft a calm reply", why: "HR is involved" },
    ...over,
  };
}

export const assessTurn = (over: Partial<Assessment> = {}) =>
  fakeMessage([{ type: "tool_use", name: "recordAssessment", input: assessment(over) as unknown as Record<string, unknown> }]);

export const tool = (name: string, input: Record<string, unknown>) => fakeMessage([{ type: "tool_use", name, input }]);
export const text = (t: string) => fakeMessage([{ type: "text", text: t }]);
