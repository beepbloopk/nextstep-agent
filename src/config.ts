import { existsSync } from "node:fs";
import path from "node:path";

// Node 22+ can read .env natively, so no dotenv dependency.
const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Provider: explicit NEXTSTEP_PROVIDER wins; otherwise whichever key is present (Gemini first,
// because it has a free tier).
const provider: "gemini" | "anthropic" =
  process.env.NEXTSTEP_PROVIDER === "anthropic" || process.env.NEXTSTEP_PROVIDER === "gemini"
    ? process.env.NEXTSTEP_PROVIDER
    : process.env.GEMINI_API_KEY
      ? "gemini"
      : "anthropic";

export const config = {
  provider,
  // Model strings change; read from env. Defaults are each provider's small/fast model.
  model: provider === "gemini" ? process.env.GEMINI_MODEL || "gemini-2.5-flash" : process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
  hasApiKey: Boolean(provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY),
  timezone: process.env.NEXTSTEP_TZ || "Asia/Kolkata",
  dataDir: path.resolve(process.env.NEXTSTEP_DATA_DIR || "./data"),
  candidateId: process.env.NEXTSTEP_CANDIDATE_ID || "",
  mockApiBase: "https://nextstepmockapi.onrender.com",

  // Budgets (blocker 3).
  maxToolCallsPerRun: intFromEnv("NEXTSTEP_MAX_TOOL_CALLS", 10),
  // Secondary cap on model round-trips. Above the tool cap, so the tool cap is what normally bites.
  maxModelTurnsPerRun: intFromEnv("NEXTSTEP_MAX_TOOL_CALLS", 10) + 2,
  maxSearchCallsPerRun: 3,

  // Staleness (blocker 2): a confirmation older than this is treated as expired.
  confirmationTtlMs: 30 * 60 * 1000,
};
