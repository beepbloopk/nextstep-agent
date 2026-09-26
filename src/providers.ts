import { config } from "./config.ts";
import { GeminiModel } from "./gemini.ts";
import { ClaudeModel, type ModelClient } from "./model.ts";

/** The one place that decides which model backs the agent. */
export function createModel(): ModelClient {
  if (config.provider === "gemini") return new GeminiModel(config.model, process.env.GEMINI_API_KEY ?? "");
  return new ClaudeModel(config.model);
}

export function missingKeyMessage(): string {
  const v = config.provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  return `${v} is not set. Put it in a .env file (see .env.example). Offline checks that need no key: npm test, npm run demo:blockers`;
}
