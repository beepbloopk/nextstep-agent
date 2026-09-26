import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./model.ts";

// Google Gemini adapter (free tier via Google AI Studio). Plain fetch against the REST API, no SDK.
//
// The agent loop speaks one message format (Anthropic's Messages shape: text / tool_use /
// tool_result blocks). This adapter translates that to Gemini's generateContent format and
// back, so the loop, the confirmation lifecycle and every safety check are provider-independent.
//
// Gemini-specific details handled here:
//  - functionResponse parts need the tool NAME, not an id, so we keep an id -> name map.
//  - Thinking models attach a thoughtSignature to parts; it must be sent back on later turns.
//    We carry it on the translated block (field `gemini_signature`) and restore it.
//  - The free tier returns 429 with a retryDelay; we wait and retry instead of failing the run.

type Json = Record<string, unknown>;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Json };
  functionResponse?: { name: string; response: Json };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

const SCHEMA_KEYS = new Set(["type", "description", "enum", "properties", "required", "items", "nullable", "format", "minItems", "maxItems"]);

/** JSON Schema (as written for Anthropic tools) -> the OpenAPI subset Gemini accepts. */
export function toGeminiSchema(schema: unknown): Json {
  if (!schema || typeof schema !== "object") return {};
  const s = schema as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      // ["string", "null"] -> type string + nullable
      const nonNull = v.filter((t) => t !== "null");
      out.type = String(nonNull[0] ?? "string").toUpperCase();
      if (v.includes("null")) out.nullable = true;
    } else if (k === "type") {
      out.type = String(v).toUpperCase();
    } else if (k === "properties") {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === "items") {
      out.items = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toolResultText(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

/** Anthropic-shaped request -> Gemini generateContent body. Exported for tests. */
export function toGeminiRequest(p: Anthropic.MessageCreateParamsNonStreaming, disableThinking: boolean): Json {
  const idToName = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (const m of p.messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else {
      for (const b of m.content as unknown as Json[]) {
        const sig = typeof b.gemini_signature === "string" ? { thoughtSignature: b.gemini_signature } : {};
        if (b.type === "text") {
          if (b.text) parts.push({ text: String(b.text), ...sig });
        } else if (b.type === "tool_use") {
          idToName.set(String(b.id), String(b.name));
          parts.push({ functionCall: { name: String(b.name), args: (b.input ?? {}) as Json }, ...sig });
        } else if (b.type === "tool_result") {
          const tb = b as unknown as Anthropic.ToolResultBlockParam;
          parts.push({
            functionResponse: {
              name: idToName.get(tb.tool_use_id) ?? "unknown_tool",
              response: { content: toolResultText(tb.content), ...(tb.is_error ? { is_error: true } : {}) },
            },
          });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }

  const body: Json = {
    contents,
    generationConfig: {
      maxOutputTokens: p.max_tokens,
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };
  if (p.system) {
    const sys = typeof p.system === "string" ? p.system : p.system.map((s) => s.text).join("\n");
    body.systemInstruction = { parts: [{ text: sys }] };
  }
  if (p.tools?.length) {
    body.tools = [
      {
        functionDeclarations: (p.tools as Anthropic.Tool[]).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: toGeminiSchema(t.input_schema),
        })),
      },
    ];
    const tc = p.tool_choice;
    body.toolConfig = {
      functionCallingConfig:
        tc?.type === "tool" ? { mode: "ANY", allowedFunctionNames: [tc.name] } : tc?.type === "any" ? { mode: "ANY" } : tc?.type === "none" ? { mode: "NONE" } : { mode: "AUTO" },
    };
  }
  return body;
}

let idSeq = 0;

/** Gemini response -> Anthropic-shaped Message. Exported for tests. */
export function fromGeminiResponse(r: GeminiResponse, model: string): Anthropic.Message {
  const cand = r.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const content: Json[] = [];
  for (const part of parts) {
    if (part.thought) continue; // thinking summaries are not part of the answer
    const sig = part.thoughtSignature ? { gemini_signature: part.thoughtSignature } : {};
    if (part.functionCall) {
      content.push({ type: "tool_use", id: `toolu_gem_${Date.now().toString(36)}_${++idSeq}`, name: part.functionCall.name, input: part.functionCall.args ?? {}, ...sig });
    } else if (typeof part.text === "string" && part.text.length) {
      content.push({ type: "text", text: part.text, citations: null, ...sig });
    }
  }
  const hasTool = content.some((c) => c.type === "tool_use");
  const finish = cand?.finishReason ?? (r.promptFeedback?.blockReason ? "BLOCKED" : "STOP");
  return {
    id: `msg_gem_${Date.now().toString(36)}_${++idSeq}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: hasTool ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: r.usageMetadata?.promptTokenCount ?? 0, output_tokens: r.usageMetadata?.candidatesTokenCount ?? 0 },
  } as unknown as Anthropic.Message;
}

export class GeminiModel implements ModelClient {
  readonly name: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(model: string, apiKey: string, opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.name = model;
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    // 2.5 Flash thinks by default; turning it off makes runs faster and more repeatable.
    const body = toGeminiRequest(params, /2\.5-flash/.test(this.name));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.name)}:generateContent`;
    let lastErr = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        lastErr = `network: ${(err as Error).message}`;
        await this.sleep(Math.min(2 ** attempt * 1000, 20_000));
        continue;
      }
      if (res.ok) return fromGeminiResponse((await res.json()) as GeminiResponse, this.name);
      const text = await res.text();
      lastErr = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      if (res.status === 429 || res.status >= 500) {
        // Free tier: honour the server's retryDelay (e.g. "17s") when it gives one.
        const m = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
        const wait = m ? Math.ceil(Number(m[1]) * 1000) + 500 : Math.min(2 ** attempt * 2000, 30_000);
        if (wait > 90_000) break; // a daily quota, not a per-minute one: fail fast with the reason
        await this.sleep(wait);
        continue;
      }
      break; // 4xx other than 429: retrying will not help
    }
    throw new Error(`Gemini request failed: ${lastErr}`);
  }
}
