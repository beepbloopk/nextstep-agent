import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.ts";
import type { Faults } from "./faults.ts";
import { MAX_UNANSWERED_PER_RECIPIENT, checkOutgoingMessage, type Refusal } from "./policy.ts";
import type { SituationStore } from "./store.ts";
import { MockOutbox, NetworkError, type OutgoingMessage } from "./tools/sendMessage.ts";
import type { Trace } from "./trace.ts";
import { actions, currentVersion, drafts, executedWithKey, versions, type ActionView } from "./views.ts";

// Lifecycle of an irreversible action. The model can only reach step 1.
//
//   1. propose  (model calls sendMessage)  -> pending, exact text frozen, nothing sent
//   2. confirm  (user, outside the model)  -> must echo the exact text they were shown
//   3. execute  (harness)                  -> idempotency check, staleness recheck, send
//
// Every step is an append to the situation log, so a crash or retry at any point can be
// resumed from the log without guessing.

export function contentHash(m: OutgoingMessage): string {
  const canonical = JSON.stringify({ r: m.recipient.trim().toLowerCase(), c: m.channel, s: m.subject ?? "", b: m.body.trim() });
  return createHash("sha256").update(canonical).digest("hex");
}

/** situation id + action type + content hash (blocker 1). Same message, same key, however many retries. */
export function idempotencyKey(sid: string, actionType: string, cHash: string): string {
  return createHash("sha256").update(`${sid}|${actionType}|${cHash}`).digest("hex").slice(0, 32);
}

/**
 * Unfilled template slots like "[Your Name]", "{{date}}" or "<Manager name>". A live run produced
 * a manager/HR email ending in "[Your Name]": exactly what an auto-send would have sent.
 */
export function findPlaceholders(text: string): string[] {
  return [...new Set(text.match(/\[[A-Z][^\]\n]{1,30}\]|\{\{[^}\n]{1,30}\}\}|<[A-Z][^>\n]{1,30}>/g) ?? [])];
}

export function renderExactText(m: OutgoingMessage): string {
  const lines = [`To: ${m.recipient} (${m.channel})`];
  if (m.subject) lines.push(`Subject: ${m.subject}`);
  lines.push("", m.body.trim());
  return lines.join("\n");
}

export type ProposeResult =
  | { status: "proposed"; action: ActionView }
  | { status: "already_pending"; action: ActionView }
  | { status: "already_sent"; action: ActionView }
  | { status: "refused"; refusal: Refusal }
  | { status: "error"; error: string };

export type ExecuteResult =
  | { status: "executed"; providerMessageId: string; reconciled: boolean }
  | { status: "duplicate_suppressed"; providerMessageId: string; note: string }
  | { status: "needs_reconfirmation"; reason: "situation_changed" | "confirmation_expired"; changes: string[]; exactText: string | null }
  | { status: "not_confirmed"; note: string }
  | { status: "failed"; error: string; outcomeUnknown: boolean; note: string }
  | { status: "refused"; refusal: Refusal };

export class ActionManager {
  private store: SituationStore;
  private outbox: MockOutbox;
  private faults?: Faults;

  constructor(store: SituationStore, outbox: MockOutbox, faults?: Faults) {
    this.store = store;
    this.outbox = outbox;
    this.faults = faults;
  }

  get(sid: string, actionId: string): ActionView | undefined {
    return actions(this.store, sid).find((a) => a.actionId === actionId);
  }

  pending(sid: string): ActionView[] {
    return actions(this.store, sid).filter((a) => ["proposed", "confirmed", "halted", "failed", "attempting"].includes(a.status));
  }

  private message(sid: string, draftId: string): OutgoingMessage | null {
    const d = drafts(this.store, sid).find((x) => x.draftId === draftId);
    return d ? { recipient: d.recipient, channel: d.channel, subject: d.subject, body: d.body } : null;
  }

  proposeSend(sid: string, draftId: string, trace?: Trace): ProposeResult {
    const msg = this.message(sid, draftId);
    if (!msg) return { status: "error", error: `unknown draft_id ${draftId}. Call draftMessage first; sendMessage only sends an existing draft.` };
    const purpose = String(drafts(this.store, sid).find((x) => x.draftId === draftId)?.purpose ?? "");
    const refusal = checkOutgoingMessage({ body: msg.body, purpose });
    if (refusal) return { status: "refused", refusal };

    const cHash = contentHash(msg);
    const key = idempotencyKey(sid, "sendMessage", cHash);
    const same = actions(this.store, sid).filter((a) => a.idempotencyKey === key);
    const sent = same.find((a) => a.status === "executed");
    if (sent) return { status: "already_sent", action: sent };
    const open = same.find((a) => a.status !== "cancelled");
    if (open) return { status: "already_pending", action: open };

    const actionId = "act_" + randomUUID().slice(0, 8);
    const exactText = renderExactText(msg);
    this.store.append(sid, "action_proposed", {
      ref: actionId,
      meta: { tool: "sendMessage", idempotencyKey: key, contentHash: cHash, situationVersion: currentVersion(this.store, sid), draftId, warnings: findPlaceholders(exactText).join(", ") || null },
      data: { exactText, recipient: msg.recipient, message: msg },
    });
    const action = this.get(sid, actionId)!;
    trace?.add("proposing", "use_tools", "irreversible_action_proposed", `Proposed sendMessage to ${msg.recipient}. Nothing sent; waiting for the user to confirm the exact text.`, {
      actionId,
      idempotencyKey: key,
      exactText,
      warnings: findPlaceholders(exactText),
    });
    return { status: "proposed", action };
  }

  /**
   * The user confirms by echoing the exact text they were shown. If it does not match the
   * frozen proposal byte for byte, the confirmation is rejected: you cannot confirm a message
   * you did not see.
   */
  confirm(sid: string, actionId: string, shownText: string, trace?: Trace): { ok: boolean; error?: string } {
    const a = this.get(sid, actionId);
    if (!a) return { ok: false, error: `unknown action ${actionId}` };
    if (!["proposed", "halted"].includes(a.status)) return { ok: false, error: `action is ${a.status}; only a proposed or halted action can be confirmed` };
    if (a.exactText === null || shownText !== a.exactText) {
      return { ok: false, error: "the text shown to the user does not match the proposed message; show the exact text and ask again" };
    }
    const v = currentVersion(this.store, sid);
    this.store.append(sid, "action_confirmed", { ref: actionId, meta: { situationVersion: v, idempotencyKey: a.idempotencyKey } });
    trace?.add("confirmed", "use_tools", "user_confirmed_exact_text", `User confirmed the exact text of ${actionId} at situation version ${v}.`, { actionId, situationVersion: v });
    return { ok: true };
  }

  /**
   * One confirmation for several sends (curveball: fewer prompts). Still exact-text: every item
   * is checked byte for byte against its own proposal, and one mismatch confirms nothing.
   */
  confirmMany(sid: string, shown: { actionId: string; shownText: string }[], trace?: Trace): { ok: boolean; error?: string } {
    for (const s of shown) {
      const a = this.get(sid, s.actionId);
      if (!a || !["proposed", "halted"].includes(a.status) || a.exactText !== s.shownText) {
        return { ok: false, error: `batch rejected: ${s.actionId} does not match what was proposed; nothing was confirmed` };
      }
    }
    for (const s of shown) {
      const r = this.confirm(sid, s.actionId, s.shownText, trace);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  cancel(sid: string, actionId: string): void {
    this.store.append(sid, "action_cancelled", { ref: actionId, meta: { reason: "user_declined" } });
  }

  execute(sid: string, actionId: string, trace?: Trace): ExecuteResult {
    const now = this.store.clock.now();
    const a = this.get(sid, actionId);
    if (!a) return { status: "not_confirmed", note: `unknown action ${actionId}` };
    const log = (label: "executed" | "reasoning", kind: string, summary: string, detail?: unknown) =>
      trace?.add(label, "use_tools", kind, summary, detail);

    // (a) Already done: replaying execute is a no-op that returns the original result.
    const done = executedWithKey(this.store, sid, a.idempotencyKey);
    if (done) {
      const pid = String(done.meta.providerMessageId);
      if (done.ref !== actionId) this.store.append(sid, "action_cancelled", { ref: actionId, meta: { reason: `duplicate_of:${done.ref}` } });
      log("reasoning", "idempotency_duplicate_suppressed", `Idempotency key ${a.idempotencyKey} already executed as ${pid}. Not sending again.`);
      return { status: "duplicate_suppressed", providerMessageId: pid, note: "This exact message was already sent. It was not sent again." };
    }

    // (b) A previous attempt ended with an unknown outcome: ask the provider before resending.
    if (a.status === "attempting" || (a.status === "failed" && a.outcomeUnknown)) {
      const found = this.outbox.lookupByClientRef(a.idempotencyKey);
      if (found) {
        this.store.append(sid, "action_executed", { ref: actionId, meta: { idempotencyKey: a.idempotencyKey, providerMessageId: found.providerMessageId, reconciled: true } });
        log("executed", "reconciled_after_network_failure", `Earlier attempt timed out, but the provider has message ${found.providerMessageId} for this key. Marked sent; NOT resent.`);
        return { status: "executed", providerMessageId: found.providerMessageId, reconciled: true };
      }
      log("reasoning", "retry_safe", "Earlier attempt failed and the provider has no message for this key, so a retry cannot double send.");
    }

    if (!["confirmed", "failed", "attempting"].includes(a.status) || a.confirmedAtVersion === null || a.confirmedAt === null) {
      return { status: "not_confirmed", note: `action is ${a.status}. It must be confirmed by the user before it can run.` };
    }

    // (c) Staleness recheck (blocker 2): the world may have moved since the user said yes.
    const cur = currentVersion(this.store, sid);
    if (cur > a.confirmedAtVersion) {
      const changes = versions(this.store, sid)
        .filter((v) => v.version > a.confirmedAtVersion!)
        .map((v) => `v${v.version} (${v.source}): ${v.text}`);
      this.store.append(sid, "action_halted", { ref: actionId, meta: { reason: "situation_changed", confirmedAtVersion: a.confirmedAtVersion, currentVersion: cur } });
      log("reasoning", "staleness_halt", `Halted ${actionId}: situation changed from v${a.confirmedAtVersion} to v${cur} after the user confirmed. Re-prompting instead of sending.`, { changes });
      return { status: "needs_reconfirmation", reason: "situation_changed", changes, exactText: a.exactText };
    }
    const ageMs = now.getTime() - new Date(a.confirmedAt).getTime();
    if (ageMs > config.confirmationTtlMs) {
      this.store.append(sid, "action_halted", { ref: actionId, meta: { reason: "confirmation_expired", ageMinutes: Math.round(ageMs / 60000) } });
      log("reasoning", "staleness_halt", `Halted ${actionId}: confirmation is ${Math.round(ageMs / 60000)} minutes old (limit ${config.confirmationTtlMs / 60000}).`);
      return { status: "needs_reconfirmation", reason: "confirmation_expired", changes: [], exactText: a.exactText };
    }

    // (d) Contact-frequency rule: no more than N unanswered messages to the same person.
    const lastInbound = versions(this.store, sid).filter((v) => v.source === "inbound").pop();
    const since = lastInbound ? new Date(lastInbound.at).getTime() : 0;
    const unanswered = actions(this.store, sid).filter(
      (x) => x.status === "executed" && x.recipient === a.recipient && new Date(x.history[x.history.length - 1].at).getTime() > since,
    ).length;
    if (unanswered >= MAX_UNANSWERED_PER_RECIPIENT) {
      const refusal: Refusal = {
        category: "harassment",
        matched: `${unanswered} unanswered messages to ${a.recipient}`,
        explanation: `You've already sent ${unanswered} messages to ${a.recipient} with no reply. I won't send more until they respond.`,
        alternative: "Give them time, or try a different way to reach them if it is urgent.",
      };
      this.store.append(sid, "action_halted", { ref: actionId, meta: { reason: "contact_frequency_limit" } });
      log("reasoning", "policy_block", refusal.explanation);
      return { status: "refused", refusal };
    }

    // (e) Send. Record the attempt FIRST, so a crash mid-send leaves evidence to reconcile against.
    const msg = this.store.read(sid).find((e) => e.type === "action_proposed" && e.ref === actionId)?.data as { message: OutgoingMessage } | null;
    if (!msg) return { status: "not_confirmed", note: "message content is unavailable (erased)" };
    this.store.append(sid, "action_attempt", { ref: actionId, meta: { idempotencyKey: a.idempotencyKey } });
    try {
      const delivered = this.outbox.send(msg.message, a.idempotencyKey, now, this.faults);
      this.store.append(sid, "action_executed", { ref: actionId, meta: { idempotencyKey: a.idempotencyKey, providerMessageId: delivered.providerMessageId, reconciled: false } });
      log("executed", "message_sent", `Sent ${actionId} to ${a.recipient} as ${delivered.providerMessageId}.`, { providerMessageId: delivered.providerMessageId });
      return { status: "executed", providerMessageId: delivered.providerMessageId, reconciled: false };
    } catch (err) {
      const unknown = err instanceof NetworkError;
      this.store.append(sid, "action_failed", { ref: actionId, meta: { idempotencyKey: a.idempotencyKey, error: (err as Error).message, outcomeUnknown: unknown } });
      log("reasoning", "send_failed", `Send failed: ${(err as Error).message}. Safe to retry: the retry checks the log and the provider first.`);
      return {
        status: "failed",
        error: (err as Error).message,
        outcomeUnknown: unknown,
        note: "The network failed. Retrying is safe: NextStep will check whether it was already delivered before sending.",
      };
    }
  }
}
