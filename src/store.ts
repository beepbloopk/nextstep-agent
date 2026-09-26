import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { Clock } from "./clock.ts";

// Append-only JSON log, one file per situation (data/situations/<sid>.jsonl).
// Nothing is ever rewritten: status changes are new entries, and state is rebuilt by replay.
//
// Each entry is split in two:
//   meta    -> plaintext, non-sensitive bookkeeping (status, version numbers, idempotency keys)
//   payload -> the sensitive content (situation text, drafts, task titles), AES-256-GCM encrypted
//              with a key that belongs to this one situation.
// "Forget this situation" deletes the key (crypto-shredding). The content becomes unreadable,
// but the plaintext meta survives, so the idempotency check still knows a message was already
// sent and can never send it twice. See README "Jugaad".

export type EntryType =
  | "situation_version"
  | "task_created"
  | "task_cancelled"
  | "task_batch"
  | "draft_created"
  | "action_proposed"
  | "action_confirmed"
  | "action_attempt"
  | "action_executed"
  | "action_failed"
  | "action_halted"
  | "action_cancelled"
  | "erasure";

export type Meta = Record<string, string | number | boolean | null>;

interface EncryptedBlob {
  iv: string;
  tag: string;
  ct: string;
}

interface RawEntry {
  seq: number;
  sid: string;
  type: EntryType;
  at: string;
  ref: string | null;
  meta: Meta;
  payload: EncryptedBlob | null;
}

export interface LogEntry<T = unknown> {
  seq: number;
  sid: string;
  type: EntryType;
  at: string;
  ref: string | null;
  meta: Meta;
  data: T | null;
  erased: boolean;
}

export class SituationStore {
  readonly dataDir: string;
  readonly clock: Clock;

  constructor(dataDir: string, clock: Clock) {
    this.dataDir = dataDir;
    this.clock = clock;
    for (const sub of ["situations", "keys", "traces"]) mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  newSituationId(): string {
    return "sit_" + randomUUID().slice(0, 8);
  }

  private logPath(sid: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sid)) throw new Error(`invalid situation id: ${sid}`);
    return path.join(this.dataDir, "situations", `${sid}.jsonl`);
  }

  private keyPath(sid: string): string {
    return path.join(this.dataDir, "keys", `${sid}.key`);
  }

  traceDir(sid: string): string {
    return path.join(this.dataDir, "traces", sid);
  }

  private getKey(sid: string, create: boolean): Buffer | null {
    const p = this.keyPath(sid);
    if (existsSync(p)) return Buffer.from(readFileSync(p, "utf8").trim(), "hex");
    if (!create) return null;
    const key = randomBytes(32);
    writeFileSync(p, key.toString("hex"), { mode: 0o600 });
    return key;
  }

  isErased(sid: string): boolean {
    return this.readRaw(sid).some((e) => e.type === "erasure");
  }

  append<T>(sid: string, type: EntryType, opts: { ref?: string; meta?: Meta; data?: T } = {}): LogEntry<T> {
    if (type !== "erasure" && this.isErased(sid)) {
      throw new Error(`situation ${sid} was erased at the user's request; refusing to write new content`);
    }
    const seq = this.readRaw(sid).length + 1;
    let payload: EncryptedBlob | null = null;
    if (opts.data !== undefined) {
      const key = this.getKey(sid, true)!;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(JSON.stringify(opts.data), "utf8"), cipher.final()]);
      payload = { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("base64") };
    }
    const raw: RawEntry = {
      seq,
      sid,
      type,
      at: this.clock.now().toISOString(),
      ref: opts.ref ?? null,
      meta: opts.meta ?? {},
      payload,
    };
    appendFileSync(this.logPath(sid), JSON.stringify(raw) + "\n", "utf8");
    return { ...raw, data: (opts.data ?? null) as T | null, erased: false };
  }

  private readRaw(sid: string): RawEntry[] {
    const p = this.logPath(sid);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RawEntry);
  }

  read(sid: string): LogEntry[] {
    const key = this.getKey(sid, false);
    return this.readRaw(sid).map((r) => {
      if (!r.payload) return { ...r, data: null, erased: false };
      if (!key) return { ...r, data: null, erased: true };
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(r.payload.iv, "hex"));
      d.setAuthTag(Buffer.from(r.payload.tag, "hex"));
      const pt = Buffer.concat([d.update(Buffer.from(r.payload.ct, "base64")), d.final()]).toString("utf8");
      return { ...r, data: JSON.parse(pt), erased: false };
    });
  }

  /**
   * "Delete everything about me" for one situation.
   * - Deletes the situation key: every encrypted payload in the append-only log is now unreadable.
   * - Deletes runtime traces (they contain prompts and model output in plaintext).
   * - Appends an erasure marker so no new content can be written under this id.
   * Keeps: plaintext meta (statuses, timestamps, idempotency hashes). That is deliberate: it is
   * what stops a retried send from going out a second time after the content is gone.
   */
  forget(sid: string): { keyDeleted: boolean; tracesDeleted: boolean } {
    const kp = this.keyPath(sid);
    const keyDeleted = existsSync(kp);
    if (keyDeleted) rmSync(kp);
    const td = this.traceDir(sid);
    const tracesDeleted = existsSync(td);
    if (tracesDeleted) rmSync(td, { recursive: true, force: true });
    this.append(sid, "erasure", { meta: { reason: "user_request" } });
    return { keyDeleted, tracesDeleted };
  }
}
