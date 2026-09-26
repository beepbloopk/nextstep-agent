"""Fault injection, so failure paths are exercised by real code. Each fault fires once."""


class Faults:
    def __init__(self):
        self._send: list[str] = []
        self._task_failures: set[int] = set()

    def fail_next_send(self, mode: str) -> "Faults":
        assert mode in ("fail_before_delivery", "fail_after_delivery")
        self._send.append(mode)
        return self

    def fail_task_at(self, index: int) -> "Faults":
        self._task_failures.add(index)
        return self

    def take_send_fault(self) -> str | None:
        return self._send.pop(0) if self._send else None

    def take_task_failure(self, index: int) -> bool:
        if index in self._task_failures:
            self._task_failures.discard(index)
            return True
        return False
