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
const rows: { run: number; codeTop: string; codeTopCategory: string; modelPickTitle: string; modelPickCategory: string; firstAction: string; status: string }[] = [];

for (let i = 1; i <= N; i++) {
  const r = await agent.start({ text: INPUT });
  const a = r.assessment;
  const top = r.priority?.top[0];
  const topProblem = a?.problems.find((p) => p.id === top?.id);
  const pick = a?.problems.find((p) => p.id === a.top_priority.problem_id);
  const firstTool = r.trace.find((s) => s.label !== "reasoning" && s.phase !== "understand");
  rows.push({
    run: i,
    codeTop: r.priority?.tie ? `TIE: ${r.priority.top.map((t) => t.title).join(" / ")}` : top?.title ?? "-",
    codeTopCategory: topProblem?.category ?? "-",
    modelPickTitle: pick?.title ?? "-",
    modelPickCategory: pick?.category ?? "-",
    firstAction: firstTool ? `${firstTool.label}:${firstTool.kind}` : "none",
    status: r.status,
  });
  console.log(rows.at(-1));
}

const same = (k: keyof (typeof rows)[number]) => new Set(rows.map((r) => r[k])).size === 1;
const verdict = {
  codeTopCategoryStable: same("codeTopCategory"),
  modelPickCategoryStable: same("modelPickCategory"),
  firstActionStable: same("firstAction"),
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
    "| run | top priority (code-ranked) | category | model's own pick | category | first action | status |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.run} | ${r.codeTop} | ${r.codeTopCategory} | ${r.modelPickTitle} | ${r.modelPickCategory} | ${r.firstAction} | ${r.status} |`),
    "",
    `- Code-ranked top category stable across runs: **${verdict.codeTopCategoryStable}**`,
    `- Model's own pick stable across runs: **${verdict.modelPickCategoryStable}**`,
    `- First action stable across runs: **${verdict.firstActionStable}**`,
    "",
    "Titles are free text written by the model, so they are compared by category, not by wording.",
  ].join("\n") + "\n",
  "utf8",
);
console.log(verdict);
