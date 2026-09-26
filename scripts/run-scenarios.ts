// Runs the agent (live model) against the 7 shared scenarios and saves the actual output.
// If the agent asks clarifying questions, one round of SIMULATED user answers is given (clearly
// labelled in the output) so the rest of the loop is visible. Pending sends are never confirmed
// here: they are shown exactly as the user would see them, waiting.
//
//   npm run scenarios                       all 7
//   npm run scenarios -- s3_contradictory   only some (e.g. to resume after a quota stop)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunResult } from "../src/agent.ts";
import { config } from "../src/config.ts";
import { SIMULATED_ANSWERS, liveAgent, loadScenarios, renderScenarioMarkdown, requireApiKey } from "./lib.ts";

requireApiKey();

const only = process.argv.slice(2);
const outDir = path.resolve("results/scenarios");
mkdirSync(outDir, { recursive: true });
const { scenarios, source } = await loadScenarios();
const { agent } = liveAgent("scenario-runs");

for (const s of scenarios.filter((x) => only.length === 0 || only.includes(x.id))) {
  console.log(`\n=== ${s.id} (${s.type}) ===`);
  const first = await agent.start({ text: s.input });
  const turns = [first];
  if (first.status === "awaiting_user" && SIMULATED_ANSWERS[s.id]) turns.push(await agent.answer(first.situationId, SIMULATED_ANSWERS[s.id]));
  const last = turns[turns.length - 1];
  writeFileSync(path.join(outDir, `${s.id}.md`), renderScenarioMarkdown(s, source, turns), "utf8");
  writeFileSync(path.join(outDir, `${s.id}.json`), JSON.stringify({ scenario: s, source, provider: config.provider, runAt: new Date().toISOString(), turns }, null, 2) + "\n", "utf8");
  console.log(`${first.status} / ${last.status} [${turns.flatMap((t) => t.modelsUsed).join(",")}]: ${last.response.slice(0, 200)}`);
}

// Summary table from every saved result, so partial re-runs keep one consistent index.
const rows = readdirSync(outDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const j = JSON.parse(readFileSync(path.join(outDir, f), "utf8")) as { scenario: { id: string; type: string }; runAt?: string; turns: RunResult[] };
    const [first, last] = [j.turns[0], j.turns[j.turns.length - 1]];
    const top = first.priority ? (first.priority.tie ? "tie" : first.priority.top[0].title) : "-";
    const models = [...new Set(j.turns.flatMap((t) => t.modelsUsed ?? []))].join(", ") || "none (policy)";
    return `| [${j.scenario.id}](${j.scenario.id}.md) | ${j.scenario.type} | ${first.mode} | ${first.status}${j.turns.length > 1 ? ` -> ${last.status}` : ""} | ${top} | ${last.pendingActions.length} | ${models} |`;
  });
writeFileSync(
  path.join(outDir, "README.md"),
  [
    "# Shared scenario pack: actual outputs",
    "",
    `Scenarios loaded from ${source}. Provider: ${config.provider}.`,
    "",
    "| id | type | mode | status | top priority (turn 1) | pending sends | model(s) that answered |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "Each `<id>.md` has the agent's reply, any drafts and messages waiting for confirmation (exact text), and the labelled trace. `<id>.json` has the full structured result.",
  ].join("\n") + "\n",
  "utf8",
);
console.log(`\nSaved to ${outDir}`);
