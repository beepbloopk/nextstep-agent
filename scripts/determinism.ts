// Blocker 8: same input 5 times, does the same top priority / first action come back?
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import { liveAgent, requireApiKey } from "./lib.ts";

requireApiKey();

const INPUT =
  process.argv[2] ??
  "Viva is at 10am tomorrow, laptop won't boot, my project partner has been ignoring my calls for 2 days, and my dad just got admitted to a hospital in Surat. I'm in Pune.";
const N = 5;
const { agent } = liveAgent("determinism");
const rows: { run: number; codeTop: string; codeTopCategory: string; modelPickTitle: string; modelPickCategory: string; firstAction: string; status: string; model: string }[] = [];

// Priority is decided in Understand + Reason, i.e. the first model call. Assess-only runs keep
// this check to 5 requests on the free tier; the model's proposed next action is in top_priority.
for (let i = 1; i <= N; i++) {
  const r = await agent.assess({ text: INPUT });
  const a = r.assessment;
  const top = r.priority?.top[0];
  const topProblem = a?.problems.find((p) => p.id === top?.id);
  const pick = a?.problems.find((p) => p.id === a.top_priority.problem_id);
  rows.push({
    run: i,
    codeTop: r.priority?.tie ? `TIE: ${r.priority.top.map((t) => t.title).join(" / ")}` : top?.title ?? "-",
    codeTopCategory: topProblem?.category ?? "-",
    modelPickTitle: pick?.title ?? "-",
    modelPickCategory: pick?.category ?? "-",
    firstAction: a?.top_priority.next_action ?? "-",
    status: r.status,
    model: r.modelsUsed.join("+"),
  });
  console.log(rows.at(-1));
}

const same = (k: keyof (typeof rows)[number]) => new Set(rows.map((r) => r[k])).size === 1;
const verdict = {
  codeTopCategoryStable: same("codeTopCategory"),
  modelPickCategoryStable: same("modelPickCategory"),
  firstActionStable: same("firstAction"),
  sameModelAllRuns: same("model"),
};
mkdirSync("results", { recursive: true });
writeFileSync(path.resolve("results/determinism.json"), JSON.stringify({ model: config.model, temperature: 0, input: INPUT, runs: rows, verdict }, null, 2) + "\n", "utf8");
writeFileSync(
  path.resolve("results/determinism.md"),
  [
    "# Determinism check (blocker 8)",
    "",
    `Model \`${config.model}\`, temperature 0, ${N} fresh runs of the same input, run at ${new Date().toISOString()}.`,
    "",
    `> ${INPUT}`,
    "",
    "| run | model | top priority (code-ranked) | category | model's own pick | category | model's proposed next action |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.run} | ${r.model} | ${r.codeTop} | ${r.codeTopCategory} | ${r.modelPickTitle} | ${r.modelPickCategory} | ${r.firstAction} |`),
    "",
    `- Code-ranked top category stable across runs: **${verdict.codeTopCategoryStable}**`,
    `- Model's own pick stable across runs: **${verdict.modelPickCategoryStable}**`,
    `- Proposed next action identical word for word: **${verdict.firstActionStable}** (free text, so wording differences are expected; compare meaning)`,
    "",
    "Titles and actions are free text written by the model, so stability is judged by category. Runs are assess-only (Understand + Reason) to fit the free-tier quota.",
  ].join("\n") + "\n",
  "utf8",
);
console.log(verdict);
