// One full run of scenario 7, end to end, in ONE trace:
// Understand -> Reason -> Ask -> (user answers) -> Use tools -> propose send -> user sees exact
// text and confirms -> execute (with a simulated network failure after delivery, then a retry
// that must NOT send twice) -> Reassess when the manager replies.
//
// The "user" here is scripted: its answers are fixed strings, and it confirms by echoing the
// exact text it was shown. Everything the agent does is live Claude + real tool code.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.ts";
import { Trace } from "../src/trace.ts";
import { liveAgent, requireApiKey } from "./lib.ts";

requireApiKey();

const INPUT = "I emailed my manager like you said and now she's angry and has CC'd HR.";
const ANSWER =
  "I told her the deadline she set was unrealistic and cc'd the whole team. She replied that my tone was unprofessional and added HR. Her name is Priya. I want to fix this without making it worse.";
const NUDGE = "Yes, please draft a short reply to Priya. I'll read it before anything is sent.";

const { agent, faults, outbox, store } = liveAgent("sample-trace");
const trace = new Trace("sample_run", "", store.clock, (s) => console.log(`${s.step}. [${s.label}] ${s.phase}/${s.kind}: ${s.summary.split("\n")[0].slice(0, 140)}`));

let r = await agent.start({ text: INPUT }, trace);
const sid = r.situationId;
const transcript: string[] = [`USER: ${INPUT}`, `AGENT: ${r.response}`];

for (const reply of [ANSWER, NUDGE]) {
  if (r.pendingActions.length) break;
  transcript.push(`USER (scripted): ${reply}`);
  r = await agent.answer(sid, reply, trace);
  transcript.push(`AGENT: ${r.response}`);
}

const pa = r.pendingActions[0];
if (!pa) {
  console.error("The agent did not propose a send in this run; trace saved anyway.");
} else {
  // What the user is shown, verbatim. They confirm by echoing it back.
  transcript.push(`SHOWN TO USER FOR CONFIRMATION:\n${pa.exactText}`, "USER (scripted): yes, send exactly this");
  const c = agent.confirm(sid, pa.actionId, pa.exactText!, trace);
  if (!c.ok) throw new Error(c.error);

  faults.failNextSend("fail_after_delivery");
  const first = agent.execute(sid, pa.actionId, trace);
  transcript.push(`SEND ATTEMPT 1: ${first.status}${"error" in first ? ` (${first.error})` : ""}`);
  const retry = agent.execute(sid, pa.actionId, trace);
  transcript.push(`SEND ATTEMPT 2 (user tapped retry): ${retry.status}${"reconciled" in retry && retry.reconciled ? " (reconciled with provider, not resent)" : ""}`);
  transcript.push(`OUTBOX now holds ${outbox.all().filter((m) => m.clientRef === agent.actions.get(sid, pa.actionId)!.idempotencyKey).length} copy of this message.`);

  // Reassess: the manager replies.
  const reply = "Priya replied: 'Thanks for this. Let's meet tomorrow at 11am with HR to reset expectations.'";
  transcript.push(`INBOUND: ${reply}`);
  r = await agent.reassess(sid, { text: reply, source: "inbound" }, trace);
  transcript.push(`AGENT: ${r.response}`);
}

const out = path.resolve("traces/sample-run-scenario7.json");
trace.save(out);
const labels = trace.steps.reduce<Record<string, number>>((m, s) => ((m[s.label] = (m[s.label] ?? 0) + 1), m), {});
writeFileSync(
  path.resolve("traces/sample-run-scenario7.md"),
  [
    "# Sample run: scenario 7 (worse after action)",
    "",
    `Model \`${config.model}\`, run at ${new Date().toISOString()}. Full labelled trace: [sample-run-scenario7.json](sample-run-scenario7.json).`,
    "",
    `Label counts: ${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    "## Conversation",
    "",
    "```text",
    ...transcript,
    "```",
    "",
    "## Steps",
    "",
    "| # | label | phase | kind | summary |",
    "|---|---|---|---|---|",
    ...trace.steps.map((s) => `| ${s.step} | ${s.label} | ${s.phase} | ${s.kind} | ${s.summary.split("\n")[0].replace(/\|/g, "/").slice(0, 180)} |`),
  ].join("\n") + "\n",
  "utf8",
);
console.log(`\nSaved ${out}`);
