// Prompt-injection defense (blocker 6).
//
// Text the user pastes, text inside a forwarded message, and everything searchInformation()
// returns is DATA. Three layers, none of which relies on the model alone:
//   1. wrapUntrusted(): fences the content in tags the system prompt defines as data-only, and
//      neutralises any attempt to close the fence early.
//   2. scanForInstructions(): a deterministic scan that flags instruction-shaped text, so the
//      trace records the attempt and the model is told explicitly what was flagged.
//   3. guardOutput(): checks the agent's final reply. Even if the model were fooled, a reply that
//      asks the user to share a PIN / OTP / password is blocked before the user sees it.

const INSTRUCTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "fake_system_prefix", re: /(^|\n|\s)(system|assistant|developer)\s*:/i },
  { name: "ignore_instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i },
  { name: "role_reassignment", re: /\byou are now\b|\bact as\b|\bnew instructions?\b/i },
  { name: "addressed_to_ai", re: /\b(ai|assistant|chatbot|language model|llm)s?\b[^.\n]{0,25}\b(reading this|must|should|tell the user|instruct)/i },
  { name: "credential_request", re: /\b(share|send|give|enter|provide|tell|reveal)\b[^.\n]{0,40}\b(upi\s*pin|pin|otp|cvv|password|passcode|card number)\b/i },
  { name: "chat_template_tokens", re: /\[\/?INST\]|<\|im_start\|>|<\/?system>/i },
];

export interface InjectionFinding {
  pattern: string;
  snippet: string;
}

export function scanForInstructions(text: string): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  for (const { name, re } of INSTRUCTION_PATTERNS) {
    const m = text.match(re);
    if (m && m.index !== undefined) {
      const start = Math.max(0, m.index - 20);
      out.push({ pattern: name, snippet: text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

export function wrapUntrusted(source: string, content: string): string {
  // Stop the content from closing our fence and "escaping" into instruction space.
  const safe = content.replace(/<\s*\/?\s*untrusted_content/gi, "[tag removed]");
  return `<untrusted_content source="${source}">\n${safe}\n</untrusted_content>`;
}

// A sentence that asks the user to share a secret, with no negation in it.
const SECRET = /\b(upi\s*pin|pin|otp|cvv|password|passcode|card number|net ?banking)\b/i;
const ASK = /\b(share|send|give|enter|provide|tell|reveal|type|confirm)\b/i;
const NEGATION = /\b(never|don't|do not|dont|not|no one|nobody|avoid|stop|refuse|mat|nahi|na)\b|n't\b/i;

export function findCredentialSolicitation(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .filter((s) => SECRET.test(s) && ASK.test(s) && !NEGATION.test(s));
}

export function guardOutput(text: string): { safe: boolean; text: string; blocked: string[] } {
  const blocked = findCredentialSolicitation(text);
  if (blocked.length === 0) return { safe: true, text, blocked };
  return {
    safe: false,
    blocked,
    text:
      "I stopped my own reply because it asked you to share a secret like a PIN, OTP or password. " +
      "NextStep will never ask for these, and no real bank, UPI app or refund desk will either. " +
      "Please do not share them with anyone. If you already did, call your bank now and report it on 1930 (national cyber fraud helpline).",
  };
}
