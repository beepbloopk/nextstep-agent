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
  autopilot: process.argv.includes("--autopilot"),
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

function sendOne(sid: string, actionId: string) {
  return agent.execute(sid, actionId);
}

async function executeWithRetry(sid: string, actionId: string) {
  let ex = sendOne(sid, actionId);
  while (ex.status === "failed") {
    console.log(`  ${ex.note}`);
    const again = (await rl.question("  Retry? (y/n): ")).trim().toLowerCase();
    if (again !== "y") break;
    ex = sendOne(sid, actionId);
  }
  if (ex.status === "executed") console.log(`  Sent (${ex.providerMessageId}).`);
  else if (ex.status === "duplicate_suppressed") console.log(`  ${ex.note}`);
  else if (ex.status === "needs_reconfirmation") console.log("  Something changed since you confirmed, so I did not send it. Let's look again.");
  else if (ex.status === "refused") console.log(`  ${ex.refusal.explanation}`);
}

async function handlePending(r: RunResult) {
  const pending = r.pendingActions.filter((p) => p.exactText);
  if (pending.length === 0) return;
  console.log("\n  ------------------------------------------------------------");
  console.log(`  NextStep wants to SEND ${pending.length === 1 ? "this message" : `these ${pending.length} messages`}. Sending cannot be undone.`);
  console.log("  ------------------------------------------------------------");
  pending.forEach((p, i) => {
    console.log(`\n  [${i + 1}]`);
    console.log(p.exactText!.split("\n").map((l) => "  | " + l).join("\n"));
    if (p.warnings) console.log(`  WARNING: this still contains ${p.warnings}. It would be sent exactly like that.`);
  });
  const prompt =
    pending.length === 1
      ? "\n  Send exactly this? Type 'send' to send, anything else to keep it as a draft: "
      : "\n  Type 'send all' to send every message above, a number to send just that one, anything else to keep them as drafts: ";
  const ans = (await rl.question(prompt)).trim().toLowerCase();
  const chosen = ans === "send" || ans === "send all" ? pending : /^\d+$/.test(ans) && pending[Number(ans) - 1] ? [pending[Number(ans) - 1]] : [];
  for (const p of pending.filter((x) => !chosen.includes(x))) agent.actions.cancel(r.situationId, p.actionId);
  if (chosen.length === 0) {
    console.log("  Nothing sent. Drafts are kept.");
    return;
  }
  // One confirmation for the batch; every text shown is still checked against its proposal.
  const c = agent.actions.confirmMany(r.situationId, chosen.map((p) => ({ actionId: p.actionId, shownText: p.exactText! })));
  if (!c.ok) {
    console.log(`  Could not confirm: ${c.error}`);
    return;
  }
  for (const p of chosen) await executeWithRetry(r.situationId, p.actionId);
}

console.log("NextStep. Tell me what's going on. Commands: 'update: <what changed>', 'autopilot on|off', 'forget', 'quit'.");
console.log(agent.autopilot ? "Autopilot is ON: I won't ask questions, I'll just act. I will still show you any message before it is sent.\n" : "");
let sid: string | null = null;
for (;;) {
  const line = (await rl.question(sid ? "> " : "What's going on? ")).trim();
  if (!line) continue;
  if (line === "quit") break;
  if (line === "autopilot on" || line === "autopilot off") {
    agent.autopilot = line.endsWith("on");
    console.log(
      agent.autopilot
        ? "Autopilot on. I'll stop asking questions and act on sensible assumptions (I'll tell you what I assumed). Messages to people still need your OK, all at once."
        : "Autopilot off. I'll ask when an answer changes what I do.",
    );
    continue;
  }
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
