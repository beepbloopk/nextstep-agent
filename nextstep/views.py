"""Read-only views rebuilt by replaying the append-only log. Nothing here writes."""
from datetime import datetime


def versions(store, sid: str) -> list[dict]:
    out = []
    for e in store.read(sid):
        if e.type != "situation_version":
            continue
        d = e.data or {}
        out.append({
            "version": int(e.meta["version"]),
            "at": e.at,
            "source": e.meta.get("source", "user"),
            "text": "[erased]" if e.erased else d.get("text", ""),
            "pasted": d.get("pasted"),
            "changes": d.get("changes"),
            "reason": d.get("reason"),
        })
    return out


def current_version(store, sid: str) -> int:
    v = versions(store, sid)
    return v[-1]["version"] if v else 0


def drafts(store, sid: str) -> list[dict]:
    return [{"draftId": e.ref, **e.data} for e in store.read(sid) if e.type == "draft_created" and e.data]


def tasks(store, sid: str) -> list[dict]:
    log = store.read(sid)
    cancelled = {e.ref for e in log if e.type == "task_cancelled"}
    return [
        {"taskId": e.ref, **(e.data or {"title": "[erased]"}), "batchId": e.meta.get("batchId"), "index": e.meta.get("index"), "cancelled": e.ref in cancelled}
        for e in log
        if e.type == "task_created"
    ]


def actions(store, sid: str) -> list[dict]:
    by_id: dict[str, dict] = {}
    for e in store.read(sid):
        if not e.type.startswith("action_") or not e.ref:
            continue
        if e.type == "action_proposed":
            d = e.data or {}
            by_id[e.ref] = {
                "actionId": e.ref,
                "tool": e.meta.get("tool"),
                "idempotencyKey": e.meta.get("idempotencyKey"),
                "contentHash": e.meta.get("contentHash"),
                "status": "proposed",
                "proposedAtVersion": e.meta.get("situationVersion"),
                "confirmedAtVersion": None,
                "confirmedAt": None,
                "exactText": None if e.erased else d.get("exactText"),
                "recipient": None if e.erased else d.get("recipient"),
                "draftId": e.meta.get("draftId"),
                "warnings": e.meta.get("warnings"),
                "lastError": None,
                "outcomeUnknown": False,
                "history": [],
            }
        a = by_id.get(e.ref)
        if not a:
            continue
        a["history"].append({"type": e.type, "at": e.at})
        if e.type == "action_confirmed":
            a.update(status="confirmed", confirmedAtVersion=e.meta.get("situationVersion"), confirmedAt=e.at)
        elif e.type == "action_attempt":
            a["status"] = "attempting"
        elif e.type == "action_executed":
            a.update(status="executed", outcomeUnknown=False)
        elif e.type == "action_failed":
            a.update(status="failed", lastError=e.meta.get("error"), outcomeUnknown=bool(e.meta.get("outcomeUnknown")))
        elif e.type == "action_halted":
            a.update(status="halted", lastError=e.meta.get("reason"))
        elif e.type == "action_cancelled":
            a["status"] = "cancelled"
    return list(by_id.values())


def executed_with_key(store, sid: str, key: str):
    """Any 'executed' line with this fingerprint, from ANY action in this situation."""
    return next((e for e in store.read(sid) if e.type == "action_executed" and e.meta.get("idempotencyKey") == key), None)


def parse_time(iso: str) -> datetime:
    return datetime.fromisoformat(iso)
