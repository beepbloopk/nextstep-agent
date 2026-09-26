"""createTask() and retryFailedTasks(): real, against the log, batch-aware (blocker 4).

A batch runs in order and stops at the first failure. The result always says which tasks exist,
which one failed and which were never tried. retryFailedTasks(batch_id) re-runs only the missing
ones; a task that already exists is skipped, never duplicated.
"""
import hashlib
import uuid

from ..views import tasks as task_view
from .calculate_time import calculate_time


def _task_key(sid: str, batch_id: str, index: int, title: str) -> str:
    return hashlib.sha256(f"{sid}|{batch_id}|{index}|{title}".encode()).hexdigest()[:16]


def _run_batch(store, sid: str, batch_id: str, items: list[dict], faults, tz: str) -> dict:
    existing = {t["index"]: t for t in task_view(store, sid) if t["batchId"] == batch_id}
    res = {"batchId": batch_id, "status": "complete", "succeeded": [], "failed": [], "remaining": [], "recovery": None}
    for i, item in enumerate(items):
        title = item.get("title", "")
        if res["failed"]:
            res["remaining"].append({"index": i, "title": title})
            continue
        if i in existing:
            prior = existing[i]
            res["succeeded"].append({"index": i, "taskId": prior["taskId"], "title": prior["title"], "due": prior.get("due"), "alreadyExisted": True})
            continue
        try:
            if faults and faults.take_task_failure(i):
                raise RuntimeError("simulated storage error while writing the task (e.g. disk or network blip)")
            due = None
            if item.get("due_expression"):
                due = (calculate_time(item["due_expression"], store.clock.now(), tz).get("resolved") or {}).get("iso")
            task_id = "task_" + uuid.uuid4().hex[:8]
            store.append(sid, "task_created", ref=task_id, meta={"batchId": batch_id, "index": i, "taskKey": _task_key(sid, batch_id, i, title)},
                         data={"title": title, "due": due, "priority": item.get("priority", "medium"), "notes": item.get("notes", "")})
            res["succeeded"].append({"index": i, "taskId": task_id, "title": title, "due": due})
        except Exception as err:  # noqa: BLE001 - any failure is reported, not raised
            res["failed"].append({"index": i, "title": title, "error": str(err)})
    if res["failed"]:
        res["status"] = "partial_failure"
        missing = len(res["failed"]) + len(res["remaining"])
        res["recovery"] = f'{len(res["succeeded"])} of {len(items)} tasks exist. Call retryFailedTasks with batch_id "{batch_id}" to create only the {missing} missing task(s); existing ones will not be duplicated.'
    return res


def create_tasks(store, sid: str, items: list[dict], faults, tz: str) -> dict:
    if not items:
        raise ValueError("createTask needs at least one task")
    if len(items) > 8:
        raise ValueError("createTask accepts at most 8 tasks per call; the user should not get a wall of tasks")
    batch_id = "batch_" + uuid.uuid4().hex[:8]
    store.append(sid, "task_batch", ref=batch_id, meta={"count": len(items)}, data={"items": items})
    return _run_batch(store, sid, batch_id, items, faults, tz)


def retry_failed_tasks(store, sid: str, batch_id: str, faults, tz: str) -> dict:
    batch = next((e for e in store.read(sid) if e.type == "task_batch" and e.ref == batch_id), None)
    if batch is None:
        raise ValueError(f"unknown batch_id {batch_id}")
    if batch.data is None:
        raise ValueError(f"batch {batch_id} content was erased")
    return _run_batch(store, sid, batch_id, batch.data["items"], faults, tz)


def cancel_task(store, sid: str, task_id: str) -> None:
    """Undo for a task: a new 'cancelled' line, nothing deleted."""
    store.append(sid, "task_cancelled", ref=task_id)
