import type { LogEntry, SituationStore } from "./store.ts";

// Read models rebuilt by replaying the append-only log. Nothing here writes.

export interface SituationVersion {
  version: number;
  at: string;
  source: "user" | "agent" | "inbound";
  text: string;
  pasted?: string;
  changes?: string[];
  reason?: string;
}

export interface Draft {
  draftId: string;
  recipient: string;
  channel: string;
  subject?: string;
  body: string;
  purpose: string;
}

export interface Task {
  taskId: string;
  title: string;
  due?: string | null;
  priority?: string;
  notes?: string;
  batchId?: string;
  index?: number;
  cancelled: boolean;
}

export type ActionStatus = "proposed" | "confirmed" | "attempting" | "executed" | "failed" | "halted" | "cancelled";

export interface ActionView {
  actionId: string;
  tool: string;
  idempotencyKey: string;
  contentHash: string;
  status: ActionStatus;
  proposedAtVersion: number;
  confirmedAtVersion: number | null;
  confirmedAt: string | null;
  exactText: string | null;
  recipient: string | null;
  draftId: string | null;
  lastError: string | null;
  outcomeUnknown: boolean;
  history: { type: string; at: string }[];
}

export function versions(store: SituationStore, sid: string): SituationVersion[] {
  return store
    .read(sid)
    .filter((e) => e.type === "situation_version")
    .map((e) => {
      const d = (e.data ?? {}) as Partial<SituationVersion>;
      return {
        version: Number(e.meta.version),
        at: e.at,
        source: (e.meta.source as SituationVersion["source"]) ?? "user",
        text: e.erased ? "[erased]" : d.text ?? "",
        pasted: d.pasted,
        changes: d.changes,
        reason: d.reason,
      };
    });
}

export function currentVersion(store: SituationStore, sid: string): number {
  const v = versions(store, sid);
  return v.length ? v[v.length - 1].version : 0;
}

export function drafts(store: SituationStore, sid: string): Draft[] {
  return store
    .read(sid)
    .filter((e) => e.type === "draft_created" && e.data)
    .map((e) => ({ draftId: e.ref!, ...(e.data as Omit<Draft, "draftId">) }));
}

export function tasks(store: SituationStore, sid: string): Task[] {
  const log = store.read(sid);
  const cancelled = new Set(log.filter((e) => e.type === "task_cancelled").map((e) => e.ref));
  return log
    .filter((e) => e.type === "task_created")
    .map((e) => ({
      taskId: e.ref!,
      ...((e.data ?? { title: "[erased]" }) as Omit<Task, "taskId" | "cancelled">),
      batchId: (e.meta.batchId as string) ?? undefined,
      index: e.meta.index as number,
      cancelled: cancelled.has(e.ref),
    }));
}

export function actions(store: SituationStore, sid: string): ActionView[] {
  const byId = new Map<string, ActionView>();
  const log: LogEntry[] = store.read(sid);
  for (const e of log) {
    if (!e.type.startsWith("action_") || !e.ref) continue;
    if (e.type === "action_proposed") {
      const d = (e.data ?? {}) as { exactText?: string; recipient?: string };
      byId.set(e.ref, {
        actionId: e.ref,
        tool: String(e.meta.tool),
        idempotencyKey: String(e.meta.idempotencyKey),
        contentHash: String(e.meta.contentHash),
        status: "proposed",
        proposedAtVersion: Number(e.meta.situationVersion),
        confirmedAtVersion: null,
        confirmedAt: null,
        exactText: e.erased ? null : d.exactText ?? null,
        recipient: e.erased ? null : d.recipient ?? null,
        draftId: (e.meta.draftId as string) ?? null,
        lastError: null,
        outcomeUnknown: false,
        history: [],
      });
    }
    const a = byId.get(e.ref);
    if (!a) continue;
    a.history.push({ type: e.type, at: e.at });
    switch (e.type) {
      case "action_confirmed":
        a.status = "confirmed";
        a.confirmedAtVersion = Number(e.meta.situationVersion);
        a.confirmedAt = e.at;
        break;
      case "action_attempt":
        a.status = "attempting";
        break;
      case "action_executed":
        a.status = "executed";
        a.outcomeUnknown = false;
        break;
      case "action_failed":
        a.status = "failed";
        a.lastError = String(e.meta.error ?? "unknown error");
        a.outcomeUnknown = Boolean(e.meta.outcomeUnknown);
        break;
      case "action_halted":
        a.status = "halted";
        a.lastError = String(e.meta.reason ?? "halted");
        break;
      case "action_cancelled":
        a.status = "cancelled";
        break;
    }
  }
  return [...byId.values()];
}

/** Any executed entry with this idempotency key, from ANY action in this situation. */
export function executedWithKey(store: SituationStore, sid: string, key: string): LogEntry | null {
  return store.read(sid).find((e) => e.type === "action_executed" && e.meta.idempotencyKey === key) ?? null;
}
