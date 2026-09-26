// Interactive CLI. The confirmation prompt lives here, outside the model's reach: the model can
// only propose a send; this code shows the exact text and records the user's answer.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { NextStepAgent, type RunResult } from "./agent.ts";
import { systemClock } from "./clock.ts";
import { config } from "./config.ts";
import { createModel, missingKeyMessage } from "./providers.ts";
import { SituationStore } from "./store.ts";
import { draftsIn } from "./trace.ts";
import { MockOutbox } from "./tools/sendMessage.ts";

if (!config.hasApiKey) {
  console.error(missingKeyMessage());
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const store = new SituationStore(config.dataDir, systemClock);
const agent = new NextStepAgent({
  store,
  model: createModel(),
  outbox: new MockOutbox(config.dataDir),
  onStep: process.env.NEXTSTEP_SHOW_TRACE ? (s) => console.log(`  [${s.label}] ${s.kind}: ${s.summary.split("\n")[0].slice(0, 120)}`) : undefined,
});

function show(r: RunResult) {
  console.log(`\n${r.response}\n`);
  for (const n of r.notices) console.log(`  (done) ${n}`);
  for (const d of draftsIn(r.trace)) {
    console.log(`\n  Draft ${d.draftId} (saved, NOT sent) to ${d.recipient} via ${d.channel}:`);
    if (d.subject) console.log(`  Subject: ${d.subject}`);
    console.log(d.body.split("\n").map((l) => "  | " + l).join("\n"));
  }
}

async function handlePending(r: RunResult) {
  for (const p of r.pendingActions) {
    console.log("\n  ------------------------------------------------------------");
    console.log("  NextStep wants to SEND this message. This cannot be undone.");
    console.log("  ------------------------------------------------------------");
    console.log(p.exactText!.split("\n").map((l) => "  | " + l).join("\n"));
    const ans = (await rl.question("\n  Send exactly this? Type 'send' to send, anything else to keep it as a draft: ")).trim().toLowerCase();
    if (ans !== "send") {
      agent.actions.cancel(r.situationId, p.actionId);
      console.log("  Not sent. The draft is kept.");
      continue;
    }
    // The CLI passes back the text it actually displayed; a mismatch is rejected.
    const c = agent.confirm(r.situationId, p.actionId, p.exactText!);
    if (!c.ok) {
      console.log(`  Could not confirm: ${c.error}`);
      continue;
    }
    let ex = agent.execute(r.situationId, p.actionId);
    while (ex.status === "failed") {
      console.log(`  ${ex.note}`);
      const again = (await rl.question("  Retry? (y/n): ")).trim().toLowerCase();
      if (again !== "y") break;
      ex = agent.execute(r.situationId, p.actionId);
    }
    if (ex.status === "executed") console.log(`  Sent (${ex.providerMessageId}).`);
    else if (ex.status === "duplicate_suppressed") console.log(`  ${ex.note}`);
    else if (ex.status === "needs_reconfirmation") console.log("  Something changed since you confirmed, so I did not send it. Let's look again.");
    else if (ex.status === "refused") console.log(`  ${ex.refusal.explanation}`);
  }
}

console.log("NextStep. Tell me what's going on. Commands: 'update: <what changed>', 'forget', 'quit'.\n");
let sid: string | null = null;
for (;;) {
  const line = (await rl.question(sid ? "> " : "What's going on? ")).trim();
  if (!line) continue;
  if (line === "quit") break;
  if (line === "forget" && sid) {
    agent.forget(sid);
    console.log("Deleted: your situation text, drafts and traces are no longer readable. Only non-content bookkeeping remains (see README, Jugaad).");
    sid = null;
    continue;
  }
  let r: RunResult;
  if (!sid) {
    const pasted = (await rl.question("Paste a forwarded message if there is one (or press Enter): ")).trim();
    r = await agent.start({ text: line, pasted: pasted || undefined });
    sid = r.situationId;
  } else if (line.startsWith("update:")) {
    r = await agent.reassess(sid, { text: line.slice(7).trim(), source: "user" });
  } else {
    r = await agent.answer(sid, line);
  }
  show(r);
  await handlePending(r);
}
rl.close();
