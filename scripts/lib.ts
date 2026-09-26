import { readFileSync } from "node:fs";
import path from "node:path";
import { NextStepAgent, type RunResult } from "../src/agent.ts";
import { systemClock, type Clock } from "../src/clock.ts";
import { config } from "../src/config.ts";
import { Faults } from "../src/faults.ts";
import { ClaudeModel } from "../src/model.ts";
import { SituationStore } from "../src/store.ts";
import { MockOutbox } from "../src/tools/sendMessage.ts";

export function requireApiKey(): void {
  if (!config.hasApiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Put it in a .env file (see .env.example). Offline checks: npm test, npm run demo:blockers");
    process.exit(1);
  }
}

export function liveAgent(dataSubdir: string, clock: Clock = systemClock) {
  const dir = path.join(config.dataDir, dataSubdir);
  const store = new SituationStore(dir, clock);
  const faults = new Faults();
  const outbox = new MockOutbox(dir);
  const agent = new NextStepAgent({ store, model: new ClaudeModel(config.model), outbox, faults });
  return { agent, store, faults, outbox };
}

export interface Scenario {
  id: string;
  type: string;
  input: string;
}

/**
 * Fetches the shared scenario pack from the NextStep mock API. The API is deliberately
 * unreliable, so: per-attempt timeout, 3 attempts with backoff, shape validation, and a
 * fallback to the local copy (scenarios/shared-scenarios.json) so a flaky API never blocks a run.
 */
export async function loadScenarios(): Promise<{ scenarios: Scenario[]; source: string }> {
  const url = `${config.mockApiBase}/v1/scenarios`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: config.candidateId ? { "X-Candidate-Id": config.candidateId } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { scenarios?: Scenario[] };
      const list = body.scenarios;
      if (!Array.isArray(list) || list.length !== 7 || !list.every((s) => s.id && s.input)) throw new Error("unexpected shape");
      return { scenarios: list, source: `${url} (attempt ${attempt})` };
    } catch (err) {
      console.warn(`scenario fetch attempt ${attempt} failed: ${(err as Error).message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  const local = JSON.parse(readFileSync(path.resolve("scenarios/shared-scenarios.json"), "utf8")) as { scenarios: Scenario[] };
  return { scenarios: local.scenarios, source: "scenarios/shared-scenarios.json (local fallback; API unavailable)" };
}

export function renderRun(r: RunResult, heading?: string): string {
  const out: string[] = [];
  if (heading) out.push(heading, "");
  out.push(`- status: \`${r.status}\`, mode: \`${r.mode}\`, tool calls: ${r.budget.toolCallsUsed}/${r.budget.maxToolCalls}`);
  if (r.priority) {
    const top = r.priority.tie ? `TIE: ${r.priority.top.map((t) => t.title).join(" / ")}` : r.priority.top[0].title;
    out.push(`- top priority (code-ranked): **${top}** (model's own pick ${r.priority.agreesWithModel ? "agrees" : "differs"})`);
  }
  if (r.assessment) {
    const a = r.assessment;
    out.push(`- understood: ${a.problems.map((p) => `${p.title} [${p.category}/${p.urgency}]`).join("; ")}`);
    if (a.contradictions?.length) out.push(`- contradictions: ${a.contradictions.map((c) => `${c.about}: ${c.statements.join(" vs ")} -> provisional: ${c.provisional_choice}`).join("; ")}`);
    if (a.missing_info?.length) out.push(`- missing info: ${a.missing_info.join("; ")}`);
    if (a.untrusted_instructions_seen?.length) out.push(`- untrusted instructions seen (not followed): ${a.untrusted_instructions_seen.join("; ")}`);
  }
  if (r.notices.length) out.push(`- actions taken: ${r.notices.join(" ")}`);
  out.push("", "**Agent reply:**", "", ...r.response.split("\n").map((l) => `> ${l}`));
  for (const p of r.pendingActions) {
    out.push("", `**Waiting for confirmation (${p.actionId}), exact text the user sees:**`, "", "```text", p.exactText ?? "", "```");
  }
  const tools = r.trace.filter((s) => s.label !== "reasoning" || s.kind !== "model_reasoning").map((s) => `${s.step}. [${s.label}] ${s.kind}: ${s.summary.split("\n")[0].slice(0, 160)}`);
  out.push("", "<details><summary>Trace (labelled steps)</summary>", "", "```text", ...tools, "```", "", "</details>");
  return out.join("\n");
}
