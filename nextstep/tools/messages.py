"""draftMessage() and the outbox that sendMessage() delivers to.

draftMessage: real. Saves a draft and returns its text. It has no way to send anything.

MockOutbox: the "outside world". Anything written to data/outbox.jsonl counts as delivered and
cannot be taken back. Like many real providers (SMTP, most chat APIs) it does NOT de-duplicate on
our fingerprint; it only lets us tag a message and look it up later. So preventing a double send is
our job, which is the point of blocker 1.

Two simulated network failures:
  fail_before_delivery: connection dropped; nothing delivered; safe to retry.
  fail_after_delivery : delivered, but the reply was lost (timeout). The caller cannot tell this
                        apart from the first case, which is exactly when a naive retry sends twice.
"""
import json
import uuid
from pathlib import Path

from ..policy import check_outgoing_message


class NetworkError(Exception):
    pass


def draft_message(store, sid: str, recipient: str, channel: str, body: str, purpose: str, subject: str | None = None) -> dict:
    refusal = check_outgoing_message(body, purpose)
    if refusal:
        return {"ok": False, "refused": refusal}
    draft_id = "draft_" + uuid.uuid4().hex[:8]
    draft = {"recipient": recipient, "channel": channel, "subject": subject, "body": body.strip(), "purpose": purpose}
    store.append(sid, "draft_created", ref=draft_id, meta={"channel": channel}, data=draft)
    return {"ok": True, "draftId": draft_id, **draft, "note": "Draft saved. Nothing has been sent."}


class MockOutbox:
    def __init__(self, data_dir: Path):
        self.file = Path(data_dir) / "outbox.jsonl"
        self._n = 0

    def all(self) -> list[dict]:
        if not self.file.exists():
            return []
        return [json.loads(line) for line in self.file.read_text(encoding="utf-8").splitlines() if line.strip()]

    def lookup(self, client_ref: str) -> dict | None:
        return next((m for m in self.all() if m["clientRef"] == client_ref), None)

    def send(self, message: dict, client_ref: str, now, faults=None) -> dict:
        fault = faults.take_send_fault() if faults else None
        if fault == "fail_before_delivery":
            raise NetworkError("ECONNRESET: connection dropped before the provider accepted the message")
        self._n += 1
        delivered = {**message, "providerMessageId": f"msg_{uuid.uuid4().hex[:8]}_{self._n}", "clientRef": client_ref, "deliveredAt": now.isoformat()}
        with self.file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(delivered, ensure_ascii=False) + "\n")
        if fault == "fail_after_delivery":
            raise NetworkError("ETIMEDOUT: no response from provider (the message may or may not have been delivered)")
        return delivered
