import Anthropic from "@anthropic-ai/sdk";

// The loop depends on this one-method interface, not on the SDK directly. That lets the
// safety tests drive the exact same loop with a scripted model (no API key, no randomness),
// while live runs use Claude.

export interface ModelClient {
  readonly name: string;
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export class ClaudeModel implements ModelClient {
  readonly name: string;
  private client: Anthropic;
  constructor(model: string) {
    this.name = model;
    // SDK retries 408/409/429/5xx and connection errors with backoff.
    this.client = new Anthropic({ maxRetries: 3, timeout: 60_000 });
  }
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    return this.client.messages.create(params);
  }
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown>; id?: string };

let seq = 0;
export function fakeMessage(blocks: Block[]): Anthropic.Message {
  const content = blocks.map((b) => (b.type === "tool_use" ? { ...b, id: b.id ?? `toolu_fake_${++seq}` } : { ...b, citations: null }));
  return {
    id: `msg_fake_${++seq}`,
    type: "message",
    role: "assistant",
    model: "scripted",
    content,
    stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/** Replays a fixed script of model turns. Used by tests and the offline blocker demo. */
export class ScriptedModel implements ModelClient {
  readonly name = "scripted";
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private turns: ((p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message)[];
  constructor(turns: (Anthropic.Message | ((p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message))[]) {
    this.turns = turns.map((t) => (typeof t === "function" ? t : () => t));
  }
  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.calls.push(params);
    const next = this.turns.shift();
    if (!next) return fakeMessage([{ type: "text", text: "(script ended)" }]);
    return next(params);
  }
}
