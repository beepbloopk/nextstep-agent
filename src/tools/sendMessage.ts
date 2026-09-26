import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Faults } from "../faults.ts";

// The "outside world" for sendMessage(). A mock messaging provider persisted to
// data/outbox.jsonl: anything written here counts as delivered and cannot be taken back.
//
// Like many real providers (SMTP, most chat APIs) it does NOT dedupe on our idempotency key.
// It only lets us tag a message with a client reference and look it up later. So preventing
// double sends is our job, which is the point of the blocker.
//
// Two simulated network failures:
//   fail_before_delivery: connection refused; nothing was delivered; safe to retry.
//   fail_after_delivery : provider accepted and delivered, but the response was lost (timeout).
//                         The caller cannot tell this apart from the first case, which is exactly
//                         the case where a naive retry sends twice.

export interface OutgoingMessage {
  recipient: string;
  channel: string;
  subject?: string;
  body: string;
}

export interface Delivered extends OutgoingMessage {
  providerMessageId: string;
  clientRef: string;
  deliveredAt: string;
}

export class NetworkError extends Error {
  readonly deliveredUnknown = true;
}

export class MockOutbox {
  private file: string;
  private nextId = 1;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "outbox.jsonl");
  }

  all(): Delivered[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Delivered);
  }

  lookupByClientRef(clientRef: string): Delivered | null {
    return this.all().find((m) => m.clientRef === clientRef) ?? null;
  }

  send(msg: OutgoingMessage, clientRef: string, now: Date, faults?: Faults): Delivered {
    const fault = faults?.takeSendFault() ?? null;
    if (fault === "fail_before_delivery") throw new NetworkError("ECONNRESET: connection dropped before the provider accepted the message");
    const delivered: Delivered = {
      ...msg,
      providerMessageId: `msg_${Date.now().toString(36)}_${this.nextId++}`,
      clientRef,
      deliveredAt: now.toISOString(),
    };
    appendFileSync(this.file, JSON.stringify(delivered) + "\n", "utf8");
    if (fault === "fail_after_delivery") throw new NetworkError("ETIMEDOUT: no response from provider (the message may or may not have been delivered)");
    return delivered;
  }
}
