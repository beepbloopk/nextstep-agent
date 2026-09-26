import { randomUUID } from "node:crypto";
import type { SituationStore } from "../store.ts";
import { checkOutgoingMessage, type Refusal } from "../policy.ts";

// draftMessage(): real implementation. Writes a draft to the log and returns its text.
// It has no transport and cannot send anything. Sending is a separate tool (sendMessage) that
// only accepts a draft_id, so the text that goes out is byte-for-byte the text the user saw.

export interface DraftInput {
  recipient: string;
  channel: "email" | "whatsapp" | "sms";
  subject?: string;
  body: string;
  purpose: string;
}

export type DraftResult =
  | { ok: true; draftId: string; recipient: string; channel: string; subject?: string; body: string; note: string }
  | { ok: false; refused: Refusal };

export function draftMessage(store: SituationStore, sid: string, input: DraftInput): DraftResult {
  const refusal = checkOutgoingMessage({ body: input.body, purpose: input.purpose });
  if (refusal) return { ok: false, refused: refusal };
  const draftId = "draft_" + randomUUID().slice(0, 8);
  const draft = {
    recipient: input.recipient,
    channel: input.channel,
    subject: input.subject,
    body: input.body.trim(),
    purpose: input.purpose,
  };
  store.append(sid, "draft_created", { ref: draftId, meta: { channel: input.channel }, data: draft });
  return { ok: true, draftId, ...draft, note: "Draft saved. Nothing has been sent." };
}
