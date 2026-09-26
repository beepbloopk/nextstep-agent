"""The life of an irreversible action. The AI can only reach step 1.

  1. propose  (AI calls sendMessage)   -> saved as pending, exact text frozen, nothing sent
  2. confirm  (user, outside the AI)   -> must echo back the exact text they were shown
  3. execute  (app code)               -> sent-once check, staleness recheck, then send

Every step is a new line in the situation log, so a crash or retry at any point can be resumed from
the log without guessing.
"""
import hashlib
import json
import re
import uuid
from datetime import datetime

from . import config
from .policy import MAX_UNANSWERED_PER_RECIPIENT, check_outgoing_message
from .tools.messages import MockOutbox, NetworkError
from .views import actions, current_version, drafts, executed_with_key, versions


def content_hash(msg: dict) -> str:
    canonical = json.dumps({"r": msg["recipient"].strip().lower(), "c": msg["channel"], "s": msg.get("subject") or "", "b": msg["body"].strip()}, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def idempotency_key(sid: str, action_type: str, c_hash: str) -> str:
    """Blocker 1: situation id + action type + content hash. Same message, same key, every retry."""
    return hashlib.sha256(f"{sid}|{action_type}|{c_hash}".encode()).hexdigest()[:32]


def render_exact_text(msg: dict) -> str:
    lines = [f"To: {msg['recipient']} ({msg['channel']})"]
    if msg.get("subject"):
        lines.append(f"Subject: {msg['subject']}")
    lines += ["", msg["body"].strip()]
    return "\n".join(lines)


def find_placeholders(text: str) -> list[str]:
    """Unfilled template slots like "[Your Name]". A live run produced a manager/HR email ending in
    "[Your Name]": exactly what sending without a look would have sent."""
    found = re.findall(r"\[[A-Z][^\]\n]{1,30}\]|\{\{[^}\n]{1,30}\}\}|<[A-Z][^>\n]{1,30}>", text)
    return list(dict.fromkeys(found))


class ActionManager:
    def __init__(self, store, outbox: MockOutbox, faults=None):
        self.store = store
        self.outbox = outbox
        self.faults = faults

    def get(self, sid: str, action_id: str) -> dict | None:
        return next((a for a in actions(self.store, sid) if a["actionId"] == action_id), None)

    def pending(self, sid: str) -> list[dict]:
        return [a for a in actions(self.store, sid) if a["status"] in ("proposed", "confirmed", "halted", "failed", "attempting")]

    # ---- 1. propose -------------------------------------------------------------------------
    def propose_send(self, sid: str, draft_id: str, trace=None) -> dict:
        d = next((x for x in drafts(self.store, sid) if x["draftId"] == draft_id), None)
        if not d:
            return {"status": "error", "error": f"unknown draft_id {draft_id}. Call draftMessage first; sendMessage only sends an existing draft."}
        refusal = check_outgoing_message(d["body"], d.get("purpose", ""))
        if refusal:
            return {"status": "refused", "refusal": refusal}
        msg = {"recipient": d["recipient"], "channel": d["channel"], "subject": d.get("subject"), "body": d["body"]}
        c_hash = content_hash(msg)
        key = idempotency_key(sid, "sendMessage", c_hash)
        same = [a for a in actions(self.store, sid) if a["idempotencyKey"] == key]
        sent = next((a for a in same if a["status"] == "executed"), None)
        if sent:
            return {"status": "already_sent", "action": sent}
        open_ = next((a for a in same if a["status"] != "cancelled"), None)
        if open_:
            return {"status": "already_pending", "action": open_}
        action_id = "act_" + uuid.uuid4().hex[:8]
        exact = render_exact_text(msg)
        warnings = ", ".join(find_placeholders(exact)) or None
        self.store.append(sid, "action_proposed", ref=action_id,
                          meta={"tool": "sendMessage", "idempotencyKey": key, "contentHash": c_hash, "situationVersion": current_version(self.store, sid), "draftId": draft_id, "warnings": warnings},
                          data={"exactText": exact, "recipient": msg["recipient"], "message": msg})
        if trace:
            trace.add("proposing", "use_tools", "irreversible_action_proposed", f"Proposed sendMessage to {msg['recipient']}. Nothing sent; waiting for the user to confirm the exact text.",
                      {"actionId": action_id, "idempotencyKey": key, "exactText": exact, "warnings": warnings})
        return {"status": "proposed", "action": self.get(sid, action_id)}

    # ---- 2. confirm -------------------------------------------------------------------------
    def confirm(self, sid: str, action_id: str, shown_text: str, trace=None) -> dict:
        """The user confirms by echoing the exact text they were shown. Any difference is rejected:
        you cannot confirm a message you did not see."""
        a = self.get(sid, action_id)
        if not a:
            return {"ok": False, "error": f"unknown action {action_id}"}
        if a["status"] not in ("proposed", "halted"):
            return {"ok": False, "error": f"action is {a['status']}; only a proposed or halted action can be confirmed"}
        if a["exactText"] is None or shown_text != a["exactText"]:
            return {"ok": False, "error": "the text shown to the user does not match the proposed message; show the exact text and ask again"}
        v = current_version(self.store, sid)
        self.store.append(sid, "action_confirmed", ref=action_id, meta={"situationVersion": v, "idempotencyKey": a["idempotencyKey"]})
        if trace:
            trace.add("confirmed", "use_tools", "user_confirmed_exact_text", f"User confirmed the exact text of {action_id} at situation version {v}.", {"actionId": action_id, "situationVersion": v})
        return {"ok": True}

    def confirm_many(self, sid: str, shown: list[dict], trace=None) -> dict:
        """Curveball: one yes for several sends. Still exact-text: every item is checked against its
        own proposal, and one mismatch confirms nothing."""
        for s in shown:
            a = self.get(sid, s["actionId"])
            if not a or a["status"] not in ("proposed", "halted") or a["exactText"] != s["shownText"]:
                return {"ok": False, "error": f"batch rejected: {s['actionId']} does not match what was proposed; nothing was confirmed"}
        for s in shown:
            r = self.confirm(sid, s["actionId"], s["shownText"], trace)
            if not r["ok"]:
                return r
        return {"ok": True}

    def cancel(self, sid: str, action_id: str) -> None:
        self.store.append(sid, "action_cancelled", ref=action_id, meta={"reason": "user_declined"})

    # ---- 3. execute -------------------------------------------------------------------------
    def execute(self, sid: str, action_id: str, trace=None) -> dict:
        now = self.store.clock.now()
        a = self.get(sid, action_id)
        if not a:
            return {"status": "not_confirmed", "note": f"unknown action {action_id}"}

        def log(label, kind, summary, detail=None):
            if trace:
                trace.add(label, "use_tools", kind, summary, detail)

        # (a) Already sent? Running execute again just returns the original result.
        done = executed_with_key(self.store, sid, a["idempotencyKey"])
        if done:
            pid = done.meta.get("providerMessageId")
            if done.ref != action_id:
                self.store.append(sid, "action_cancelled", ref=action_id, meta={"reason": f"duplicate_of:{done.ref}"})
            log("reasoning", "idempotency_duplicate_suppressed", f"Fingerprint {a['idempotencyKey']} was already sent as {pid}. Not sending again.")
            return {"status": "duplicate_suppressed", "providerMessageId": pid, "note": "This exact message was already sent. It was not sent again."}

        # (b) An earlier try ended with an unknown result: ask the outbox before sending again.
        if a["status"] == "attempting" or (a["status"] == "failed" and a["outcomeUnknown"]):
            found = self.outbox.lookup(a["idempotencyKey"])
            if found:
                self.store.append(sid, "action_executed", ref=action_id, meta={"idempotencyKey": a["idempotencyKey"], "providerMessageId": found["providerMessageId"], "reconciled": True})
                log("executed", "reconciled_after_network_failure", f"Earlier attempt timed out, but the outbox has message {found['providerMessageId']} for this fingerprint. Marked sent; NOT resent.")
                return {"status": "executed", "providerMessageId": found["providerMessageId"], "reconciled": True}
            log("reasoning", "retry_safe", "Earlier attempt failed and the outbox has no message for this fingerprint, so a retry cannot double send.")

        if a["status"] not in ("confirmed", "failed", "attempting") or a["confirmedAtVersion"] is None:
            return {"status": "not_confirmed", "note": f"action is {a['status']}. It must be confirmed by the user before it can run."}

        # (c) Staleness recheck (blocker 2): the world may have moved since the user said yes.
        cur = current_version(self.store, sid)
        if cur > a["confirmedAtVersion"]:
            changes = [f"v{v['version']} ({v['source']}): {v['text']}" for v in versions(self.store, sid) if v["version"] > a["confirmedAtVersion"]]
            self.store.append(sid, "action_halted", ref=action_id, meta={"reason": "situation_changed", "confirmedAtVersion": a["confirmedAtVersion"], "currentVersion": cur})
            log("reasoning", "staleness_halt", f"Halted {action_id}: situation changed from v{a['confirmedAtVersion']} to v{cur} after the user confirmed. Asking again instead of sending.", {"changes": changes})
            return {"status": "needs_reconfirmation", "reason": "situation_changed", "changes": changes, "exactText": a["exactText"]}
        age = (now - datetime.fromisoformat(a["confirmedAt"])).total_seconds()
        if age > config.CONFIRMATION_TTL_SECONDS:
            self.store.append(sid, "action_halted", ref=action_id, meta={"reason": "confirmation_expired", "ageMinutes": round(age / 60)})
            log("reasoning", "staleness_halt", f"Halted {action_id}: the yes is {round(age / 60)} minutes old.")
            return {"status": "needs_reconfirmation", "reason": "confirmation_expired", "changes": [], "exactText": a["exactText"]}

        # (d) At most N unanswered messages to the same person.
        inbound = [v for v in versions(self.store, sid) if v["source"] == "inbound"]
        since = datetime.fromisoformat(inbound[-1]["at"]) if inbound else None
        unanswered = sum(
            1 for x in actions(self.store, sid)
            if x["status"] == "executed" and x["recipient"] == a["recipient"] and (since is None or datetime.fromisoformat(x["history"][-1]["at"]) > since)
        )
        if unanswered >= MAX_UNANSWERED_PER_RECIPIENT:
            refusal = {"category": "harassment", "matched": f"{unanswered} unanswered messages to {a['recipient']}",
                       "explanation": f"You've already sent {unanswered} messages to {a['recipient']} with no reply. I won't send more until they respond.",
                       "alternative": "Give them time, or try a different way to reach them if it is urgent."}
            self.store.append(sid, "action_halted", ref=action_id, meta={"reason": "contact_frequency_limit"})
            log("reasoning", "policy_block", refusal["explanation"])
            return {"status": "refused", "refusal": refusal}

        # (e) Send. Write the attempt FIRST, so a crash mid-send leaves a record to check against.
        proposal = next((e for e in self.store.read(sid) if e.type == "action_proposed" and e.ref == action_id), None)
        if not proposal or not proposal.data:
            return {"status": "not_confirmed", "note": "message content is unavailable (erased)"}
        self.store.append(sid, "action_attempt", ref=action_id, meta={"idempotencyKey": a["idempotencyKey"]})
        try:
            delivered = self.outbox.send(proposal.data["message"], a["idempotencyKey"], now, self.faults)
        except NetworkError as err:
            self.store.append(sid, "action_failed", ref=action_id, meta={"idempotencyKey": a["idempotencyKey"], "error": str(err), "outcomeUnknown": True})
            log("reasoning", "send_failed", f"Send failed: {err}. Safe to retry: the retry checks the log and the outbox first.")
            return {"status": "failed", "error": str(err), "outcomeUnknown": True, "note": "The network failed. Retrying is safe: NextStep will check whether it was already delivered before sending."}
        self.store.append(sid, "action_executed", ref=action_id, meta={"idempotencyKey": a["idempotencyKey"], "providerMessageId": delivered["providerMessageId"], "reconciled": False})
        log("executed", "message_sent", f"Sent {action_id} to {a['recipient']} as {delivered['providerMessageId']}.", {"providerMessageId": delivered["providerMessageId"]})
        return {"status": "executed", "providerMessageId": delivered["providerMessageId"], "reconciled": False}
