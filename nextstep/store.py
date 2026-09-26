"""Append-only JSON log, one file per situation: data/situations/<sid>.jsonl.

Nothing is ever rewritten. Status changes are new lines, and state is rebuilt by replaying.

Each line has two parts:
  meta    -> plain, non-private bookkeeping (status, versions, message fingerprints)
  payload -> the private content (what the user wrote, drafts, task titles), AES-256-GCM
             encrypted with a key that belongs to this one situation.
"Forget this situation" deletes the key. The content becomes unreadable, but the bookkeeping
stays, so a late retry still cannot send a message twice. See README, Jugaad.
"""
import base64
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


@dataclass
class LogEntry:
    seq: int
    sid: str
    type: str
    at: str
    ref: str | None
    meta: dict
    data: Any = None
    erased: bool = False


class SituationStore:
    def __init__(self, data_dir: Path, clock):
        self.data_dir = Path(data_dir)
        self.clock = clock
        for sub in ("situations", "keys", "traces"):
            (self.data_dir / sub).mkdir(parents=True, exist_ok=True)

    def new_situation_id(self) -> str:
        return "sit_" + uuid.uuid4().hex[:8]

    def _log_path(self, sid: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
            raise ValueError(f"invalid situation id: {sid}")
        return self.data_dir / "situations" / f"{sid}.jsonl"

    def _key_path(self, sid: str) -> Path:
        return self.data_dir / "keys" / f"{sid}.key"

    def trace_dir(self, sid: str) -> Path:
        return self.data_dir / "traces" / sid

    def _key(self, sid: str, create: bool) -> bytes | None:
        p = self._key_path(sid)
        if p.exists():
            return bytes.fromhex(p.read_text().strip())
        if not create:
            return None
        key = AESGCM.generate_key(bit_length=256)
        p.write_text(key.hex())
        return key

    def _raw(self, sid: str) -> list[dict]:
        p = self._log_path(sid)
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]

    def is_erased(self, sid: str) -> bool:
        return any(e["type"] == "erasure" for e in self._raw(sid))

    def append(self, sid: str, type: str, ref: str | None = None, meta: dict | None = None, data: Any = None) -> LogEntry:
        if type != "erasure" and self.is_erased(sid):
            raise RuntimeError(f"situation {sid} was erased at the user's request; refusing to write new content")
        payload = None
        if data is not None:
            key = self._key(sid, create=True)
            nonce = os.urandom(12)
            ct = AESGCM(key).encrypt(nonce, json.dumps(data, ensure_ascii=False).encode("utf-8"), None)
            payload = {"nonce": nonce.hex(), "ct": base64.b64encode(ct).decode()}
        raw = {
            "seq": len(self._raw(sid)) + 1,
            "sid": sid,
            "type": type,
            "at": self.clock.now().isoformat(),
            "ref": ref,
            "meta": meta or {},
            "payload": payload,
        }
        with self._log_path(sid).open("a", encoding="utf-8") as f:
            f.write(json.dumps(raw, ensure_ascii=False) + "\n")
        return LogEntry(raw["seq"], sid, type, raw["at"], ref, raw["meta"], data, False)

    def read(self, sid: str) -> list[LogEntry]:
        key = self._key(sid, create=False)
        out = []
        for r in self._raw(sid):
            data, erased = None, False
            if r["payload"]:
                if key is None:
                    erased = True
                else:
                    nonce = bytes.fromhex(r["payload"]["nonce"])
                    pt = AESGCM(key).decrypt(nonce, base64.b64decode(r["payload"]["ct"]), None)
                    data = json.loads(pt.decode("utf-8"))
            out.append(LogEntry(r["seq"], r["sid"], r["type"], r["at"], r["ref"], r["meta"], data, erased))
        return out

    def forget(self, sid: str) -> dict:
        """'Delete everything about me' for one situation. Keeps only non-private bookkeeping."""
        kp = self._key_path(sid)
        key_deleted = kp.exists()
        if key_deleted:
            kp.unlink()
        td = self.trace_dir(sid)
        traces_deleted = td.exists()
        if traces_deleted:
            shutil.rmtree(td)
        self.append(sid, "erasure", meta={"reason": "user_request"})
        return {"key_deleted": key_deleted, "traces_deleted": traces_deleted}
