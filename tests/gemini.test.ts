import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiModel, fromGeminiResponse, toGeminiRequest, toGeminiSchema } from "../src/gemini.ts";
import { recordAssessmentTool } from "../src/toolDefs.ts";
import { assessment, env } from "./helpers.ts";
import { NextStepAgent } from "../src/agent.ts";

test("gemini: JSON schema is converted to Gemini's subset (nullable unions, nested items)", () => {
  const g = toGeminiSchema(recordAssessmentTool.input_schema) as { type: string; properties: Record<string, any> };
  assert.equal(g.type, "OBJECT");
  const dl = g.properties.problems.items.properties.deadline_text;
  assert.equal(dl.type, "STRING");
  assert.equal(dl.nullable, true);
});

test("gemini: forced tool choice, system prompt, tool results by name, thought signatures round-trip", () => {
  const body = toGeminiRequest(
    {
      model: "x",
      max_tokens: 100,
      temperature: 0,
      system: "SYS",
      tools: [recordAssessmentTool],
      tool_choice: { type: "tool", name: "recordAssessment" },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "calculateTime", input: { expression: "kal" }, gemini_signature: "SIG" } as never] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      ],
    },
    true,
  ) as any;
  assert.deepEqual(body.toolConfig.functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["recordAssessment"] });
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.equal(body.contents[1].role, "model");
  assert.equal(body.contents[1].parts[0].thoughtSignature, "SIG");
  assert.equal(body.contents[2].parts[0].functionResponse.name, "calculateTime");
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test("gemini: response parts become text / tool_use blocks; thought parts are dropped", () => {
  const m = fromGeminiResponse(
    { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text: "Hello" }, { functionCall: { name: "askUser", args: { questions: ["q"] } }, thoughtSignature: "S" }] } }] },
    "gemini-test",
  );
  assert.equal(m.stop_reason, "tool_use");
  assert.equal(m.content.length, 2);
  assert.equal((m.content[1] as any).name, "askUser");
  assert.equal((m.content[1] as any).gemini_signature, "S");
});

test("gemini: 429 with retryDelay is waited out and retried", async () => {
  let calls = 0;
  const waits: number[] = [];
  const fakeFetch = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { details: [{ retryDelay: "3s" }] } }).replace('"retryDelay":"3s"', '"retryDelay": "3s"'), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }), { status: 200 });
  }) as typeof fetch;
  const g = new GeminiModel("gemini-test", "k", { fetchImpl: fakeFetch, sleep: async (ms) => void waits.push(ms) });
  const m = await g.create({ model: "x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 3000);
  assert.equal((m.content[0] as any).text, "ok");
});

test("gemini: the real agent loop runs end to end through the adapter", async () => {
  const replies = [
    { candidates: [{ content: { parts: [{ functionCall: { name: "recordAssessment", args: assessment() } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: "calculateTime", args: { expression: "10am tomorrow" } } }] } }] },
    { candidates: [{ content: { parts: [{ text: "Your viva is in about 14 hours. Start with the slides." }] }, finishReason: "STOP" }] },
  ];
  const bodies: any[] = [];
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  const e = env();
  const agent = new NextStepAgent({ store: e.store, model: new GeminiModel("gemini-test", "k", { fetchImpl: fakeFetch }), outbox: e.outbox });
  const r = await agent.start({ text: "Viva at 10am tomorrow" });
  assert.equal(r.status, "completed");
  assert.ok(r.trace.some((s) => s.kind === "calculateTime" && s.label === "executed"));
  assert.ok(r.response.includes("viva"));
  // The tool result went back as a functionResponse named after the tool.
  assert.equal(bodies[2].contents.at(-1).parts[0].functionResponse.name, "calculateTime");
});
