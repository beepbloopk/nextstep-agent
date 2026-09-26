import assert from "node:assert/strict";
import { test } from "node:test";
import { NextStepAgent } from "../src/agent.ts";
import { findPlaceholders } from "../src/actions.ts";
import { assessTurn, env, text, tool } from "./helpers.ts";

// Curveball: "Users are annoyed by confirmations. Just do everything, stop asking me."

function autopilotAgent(turns: Parameters<typeof env>[1]) {
  const e = env(undefined, turns);
  const agent = new NextStepAgent({ store: e.store, model: e.model, outbox: e.outbox, faults: e.faults, autopilot: true });
  return { ...e, agent };
}

const draftThenSend = (body: string) => {
  let draftId = "";
  return [
    assessTurn(),
    tool("draftMessage", { recipient: "Manager (Priya)", channel: "email", body, purpose: "reply to manager" }),
    (p: any) => {
      draftId = JSON.parse(p.messages.at(-1).content[0].content).draftId;
      return tool("sendMessage", { draft_id: draftId });
    },
    text("Assumed: you want a short apology. Drafted it for you."),
  ];
};

test("curveball: autopilot does not offer askUser to the model and states it in the trace", async () => {
  const e = autopilotAgent([assessTurn(), text("Assumed: deadline is Thursday. Created your plan.")]);
  const r = await e.agent.start({ text: "deadline friday or thursday?" });
  const offered = (e.model.calls[1].tools ?? []).map((t: any) => t.name);
  assert.ok(!offered.includes("askUser"));
  assert.ok(String(e.model.calls[1].system).includes("AUTOPILOT IS ON"));
  assert.ok(r.trace.some((s) => s.kind === "autopilot_on"));
  assert.equal(r.status, "completed");
});

test("curveball: if a model asks anyway in autopilot, the question is suppressed and the run continues", async () => {
  const e = autopilotAgent([assessTurn(), tool("askUser", { questions: ["Which day?"], why: "x" }), text("Assumed: Thursday.")]);
  const r = await e.agent.start({ text: "deadline friday or thursday?" });
  assert.equal(r.status, "completed");
  assert.equal(r.questions.length, 0);
  assert.ok(r.trace.some((s) => s.kind === "autopilot_question_suppressed"));
});

test("curveball: autopilot NEVER sends without exact-text confirmation", async () => {
  const e = autopilotAgent(draftThenSend("Hi Priya, sorry about my email. Can we talk today?"));
  const r = await e.agent.start({ text: "manager angry, just handle it, stop asking me" });
  assert.equal(r.status, "awaiting_confirmation");
  assert.equal(e.outbox.all().length, 0);
  assert.equal(e.agent.execute(r.situationId, r.pendingActions[0].actionId).status, "not_confirmed");
  assert.equal(e.outbox.all().length, 0);
});

test("curveball: batch confirmation is all-or-nothing on exact text", async () => {
  const e = autopilotAgent(draftThenSend("Hi Priya, sorry about my email. Can we talk today?"));
  const r = await e.agent.start({ text: "handle it" });
  const p = r.pendingActions[0];
  assert.equal(e.agent.actions.confirmMany(r.situationId, [{ actionId: p.actionId, shownText: p.exactText + "!" }]).ok, false);
  assert.equal(e.agent.actions.get(r.situationId, p.actionId)!.status, "proposed");
  assert.equal(e.agent.actions.confirmMany(r.situationId, [{ actionId: p.actionId, shownText: p.exactText! }]).ok, true);
  assert.equal(e.agent.execute(r.situationId, p.actionId).status, "executed");
});

test("curveball: unfilled placeholders are flagged on the proposal the user confirms", async () => {
  // From a real run: a manager + HR email that ended with "[Your Name]".
  assert.deepEqual(findPlaceholders("Best regards,\n[Your Name]"), ["[Your Name]"]);
  assert.deepEqual(findPlaceholders("See you on {{date}} at <Meeting Room>"), ["{{date}}", "<Meeting Room>"]);
  assert.deepEqual(findPlaceholders("I'll send [the slides] tonight"), []);
  const e = autopilotAgent(draftThenSend("Hi Priya, sorry about my email.\n\nBest regards,\n[Your Name]"));
  const r = await e.agent.start({ text: "handle it" });
  assert.equal(r.pendingActions[0].warnings, "[Your Name]");
});
