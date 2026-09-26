// Curveball evidence: the same input with autopilot off (saved in results/scenarios/s3_contradictory.md)
// and on (this run). Writes results/curveball-autopilot.md.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { NextStepAgent } from "../src/agent.ts";
import { MockOutbox } from "../src/tools/sendMessage.ts";
import { createModel } from "../src/providers.ts";
import { SituationStore } from "../src/store.ts";
import { systemClock } from "../src/clock.ts";
import { config } from "../src/config.ts";
import { renderRun, requireApiKey } from "./lib.ts";

requireApiKey();
const dir = path.join(config.dataDir, "curveball");
const store = new SituationStore(dir, systemClock);
const agent = new NextStepAgent({ store, model: createModel(), outbox: new MockOutbox(dir), autopilot: true });
const input = process.argv[2] ?? "My deadline is Friday… actually wait, I think the professor said Thursday. I have no savings but I can probably borrow from my roommate, although we're not talking right now.";
const r = await agent.start({ text: input });
writeFileSync(
  path.resolve("results/curveball-autopilot.md"),
  [
    "# Curveball: autopilot run",
    "",
    `Run at ${new Date().toISOString()}. Same input as [scenario 3](scenarios/s3_contradictory.md), where the default agent stopped to ask which deadline was right. Here autopilot is on.`,
    "",
    `> ${input}`,
    "",
    renderRun(r),
  ].join("\n") + "\n",
  "utf8",
);
console.log(r.status, r.modelsUsed, "\n" + r.response);
