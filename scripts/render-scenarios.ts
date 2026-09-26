// Re-renders results/scenarios/*.md from the saved *.json results (no model calls).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderScenarioMarkdown } from "./lib.ts";

const dir = path.resolve("results/scenarios");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const md = renderScenarioMarkdown(j.scenario, j.source ?? "https://nextstepmockapi.onrender.com/v1/scenarios", j.turns);
  writeFileSync(path.join(dir, f.replace(/\.json$/, ".md")), md, "utf8");
  console.log("rendered", f);
}
