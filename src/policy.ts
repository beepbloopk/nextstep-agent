// The agent's own policy layer (blocker 7 and the at-risk path for scenario 4).
//
// Deterministic rules run BEFORE any model call and again inside draftMessage/sendMessage.
// Rules are narrow on purpose: they catch the clear cases instantly and explainably. Paraphrases
// that slip past them are caught by the model's assessment (request_type = "harmful",
// risk_level != "none"), which routes to the same refusal / support paths.

export type RefusalCategory = "deception_forgery" | "harassment" | "credential_phishing";

export interface Refusal {
  category: RefusalCategory;
  matched: string;
  explanation: string;
  alternative: string;
}

const REQUEST_RULES: { category: RefusalCategory; re: RegExp; explanation: string; alternative: string }[] = [
  {
    category: "deception_forgery",
    re: /\b(fake|forged?|made[- ]?up|false|bogus|fabricated?|phony|nakli|jhoota)\b[^.\n]{0,25}\b(medical|doctor'?s?|sick|illness|hospital|certificate|excuse|note|leave letter|prescription)\b|\b(pretend|lie|say|claim)\b[^.\n]{0,20}\b(i was|i am|i'm|that i)\b[^.\n]{0,15}\b(sick|ill|hospitali[sz]ed|unwell)\b/i,
    explanation:
      "I can't draft a fake medical excuse. It is a false document, and if it is checked it can turn a missed deadline into a disciplinary case.",
    alternative:
      "I can help you write an honest message to your professor asking for an extension, saying you fell behind and proposing a new date. Honest requests work more often than people expect.",
  },
  {
    category: "harassment",
    re: /\b(message|text|call|dm|ping|spam|keep (?:messaging|texting|calling))\b[^.\n]{0,30}\b(until|till|untill|repeatedly|non-?stop|again and again|every (?:hour|day|minute))\b|\buntil (she|he|they) (replies|responds|answers|picks up|talks)\b/i,
    explanation:
      "I won't keep messaging someone until they reply. When a person is not responding, repeated messages usually feel like pressure, and they can cross into harassment.",
    alternative:
      "If you want, I can help you write one clear, calm message that says what you need to say and leaves the choice to reply with them. Or we can talk through how you're feeling about the silence.",
  },
  {
    category: "credential_phishing",
    re: /\b(get|ask|make|trick|convince)\b[^.\n]{0,30}\b(their|his|her|someone'?s)\b[^.\n]{0,20}\b(upi\s*pin|pin|otp|password|cvv)\b/i,
    explanation: "I can't help get someone else's PIN, OTP or password. That is how most UPI fraud works.",
    alternative: "If you are worried about a payment or an account, I can help you contact the bank or report it on 1930.",
  },
];

export function screenRequest(text: string): Refusal | null {
  for (const r of REQUEST_RULES) {
    const m = text.match(r.re);
    if (m) return { category: r.category, matched: m[0], explanation: r.explanation, alternative: r.alternative };
  }
  return null;
}

export type RiskLevel = "none" | "elevated" | "acute";

const ACUTE = /\b(kill myself|end (it all|my life)|suicid\w*|want to die|wanna die|don'?t want to (live|be alive|exist)|no reason to live|better off without me|want it all to stop|hurt myself|self[- ]harm|mar jaana|marna chahta|marna chahti|jeena nahi|khatam kar (dun|doon|lu|loon))\b/i;
const ELEVATED = /\b(what'?s the point|whats the point|what is the point|so tired of (it|all|everything)|tired of all of it|can'?t (do|take) (this|it) anymore|give up on everything|nothing matters|everything is falling apart|hopeless|no way out|koi fayda nahi|sab khatam)\b/i;

export function screenRisk(text: string): { level: RiskLevel; signals: string[] } {
  const signals: string[] = [];
  const a = text.match(ACUTE);
  if (a) signals.push(a[0]);
  const e = text.match(ELEVATED);
  if (e) signals.push(e[0]);
  return { level: a ? "acute" : e ? "elevated" : "none", signals };
}

/** Second gate: inside draftMessage/sendMessage, on the actual message and its stated purpose. */
export function checkOutgoingMessage(msg: { body: string; purpose: string }): Refusal | null {
  const req = screenRequest(`${msg.purpose}\n${msg.body}`);
  if (req) return req;
  if (/\b(share|send|give|tell)\b[^.\n]{0,30}\b(upi\s*pin|otp|password|cvv)\b/i.test(msg.body)) {
    return {
      category: "credential_phishing",
      matched: "message asks the recipient for a secret",
      explanation: "This message asks someone to share a PIN, OTP or password. I won't send that.",
      alternative: "Rewrite the message without asking for any secret.",
    };
  }
  return null;
}

/** Contact-frequency rule: stops "message them until they reply" even if it is phrased politely. */
export const MAX_UNANSWERED_PER_RECIPIENT = 2;
