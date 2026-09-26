import { createHash, randomUUID } from "node:crypto";
import type { SituationStore } from "../store.ts";
import type { Faults } from "../faults.ts";
import { tasks as taskView } from "../views.ts";
import { calculateTime } from "./calculateTime.ts";

// createTask(): real implementation against the JSON log, batch-aware (blocker 4).
//
// A batch runs in order and stops at the first failure. The result always says exactly which
// tasks exist, which one failed and which were never attempted, so neither the user nor the
// model has to guess. retryFailedTasks(batchId) re-runs only failed + remaining tasks; every
// task has a deterministic key, so a task that already exists is skipped, never duplicated.

export interface TaskInput {
  title: string;
  due_expression?: string;
  priority?: "high" | "medium" | "low";
  notes?: string;
}

export interface BatchResult {
  batchId: string;
  status: "complete" | "partial_failure";
  succeeded: { index: number; taskId: string; title: string; due: string | null; alreadyExisted?: boolean }[];
  failed: { index: number; title: string; error: string }[];
  remaining: { index: number; title: string }[];
  recovery: string | null;
}

function taskKey(sid: string, batchId: string, index: number, title: string): string {
  return createHash("sha256").update(`${sid}|${batchId}|${index}|${title}`).digest("hex").slice(0, 16);
}

function runBatch(
  store: SituationStore,
  sid: string,
  batchId: string,
  items: TaskInput[],
  faults: Faults | undefined,
  tz: string,
): BatchResult {
  const existing = new Map(taskView(store, sid).filter((t) => t.batchId === batchId).map((t) => [t.index!, t]));
  const res: BatchResult = { batchId, status: "complete", succeeded: [], failed: [], remaining: [], recovery: null };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (res.failed.length > 0) {
      res.remaining.push({ index: i, title: item.title });
      continue;
    }
    const prior = existing.get(i);
    if (prior) {
      res.succeeded.push({ index: i, taskId: prior.taskId, title: prior.title, due: prior.due ?? null, alreadyExisted: true });
      continue;
    }
    try {
      if (faults?.takeTaskFailure(i)) throw new Error("simulated storage error while writing the task (e.g. disk or network blip)");
      const due = item.due_expression ? calculateTime({ expression: item.due_expression }, store.clock.now(), tz).resolved?.iso ?? null : null;
      const taskId = "task_" + randomUUID().slice(0, 8);
      store.append(sid, "task_created", {
        ref: taskId,
        meta: { batchId, index: i, taskKey: taskKey(sid, batchId, i, item.title) },
        data: { title: item.title, due, priority: item.priority ?? "medium", notes: item.notes ?? "" },
      });
      res.succeeded.push({ index: i, taskId, title: item.title, due });
    } catch (err) {
      res.failed.push({ index: i, title: item.title, error: (err as Error).message });
    }
  }

  if (res.failed.length > 0) {
    res.status = "partial_failure";
    res.recovery = `${res.succeeded.length} of ${items.length} tasks exist. Call retryFailedTasks with batch_id "${batchId}" to create only the ${res.failed.length + res.remaining.length} missing task(s); existing ones will not be duplicated.`;
  }
  return res;
}

export function createTasks(store: SituationStore, sid: string, items: TaskInput[], faults: Faults | undefined, tz: string): BatchResult {
  if (!Array.isArray(items) || items.length === 0) throw new Error("createTask needs at least one task");
  if (items.length > 8) throw new Error("createTask accepts at most 8 tasks per call; the user should not get a wall of tasks");
  const batchId = "batch_" + randomUUID().slice(0, 8);
  store.append(sid, "task_batch", { ref: batchId, meta: { count: items.length }, data: { items } });
  return runBatch(store, sid, batchId, items, faults, tz);
}

export function retryFailedTasks(store: SituationStore, sid: string, batchId: string, faults: Faults | undefined, tz: string): BatchResult {
  const batch = store.read(sid).find((e) => e.type === "task_batch" && e.ref === batchId);
  if (!batch) throw new Error(`unknown batch_id ${batchId}`);
  if (!batch.data) throw new Error(`batch ${batchId} content was erased`);
  return runBatch(store, sid, batchId, (batch.data as { items: TaskInput[] }).items, faults, tz);
}

export function cancelTask(store: SituationStore, sid: string, taskId: string): void {
  store.append(sid, "task_cancelled", { ref: taskId });
}
