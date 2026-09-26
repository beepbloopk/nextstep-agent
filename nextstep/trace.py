"""Every step of a run is labelled with one of five labels. Extra detail goes in `kind`."""
import json
from pathlib import Path

LABELS = ("reasoning", "asking", "proposing", "confirmed", "executed")


class Trace:
    def __init__(self, run_id: str, sid: str, clock, on_step=None):
        self.run_id = run_id
        self.sid = sid
        self.clock = clock
        self.on_step = on_step
        self.steps: list[dict] = []

    def add(self, label: str, phase: str, kind: str, summary: str, detail=None) -> dict:
        assert label in LABELS, label
        step = {"step": len(self.steps) + 1, "label": label, "phase": phase, "kind": kind, "at": self.clock.now().isoformat(), "summary": summary}
        if detail is not None:
            step["detail"] = detail
        self.steps.append(step)
        if self.on_step:
            self.on_step(step)
        return step

    def to_dict(self) -> dict:
        return {"runId": self.run_id, "situationId": self.sid, "steps": self.steps}

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")


def drafts_in(steps: list[dict]) -> list[dict]:
    """Drafts saved during a run, read back from their trace steps."""
    return [s["detail"] for s in steps if s["kind"] == "draft_saved" and s.get("detail")]
