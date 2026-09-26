"""Every time-based decision goes through a Clock, so tests can pin 'now' or skip 10 minutes ahead."""
from datetime import datetime, timedelta, timezone


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class FakeClock:
    def __init__(self, start: str):
        self._t = datetime.fromisoformat(start).astimezone(timezone.utc)

    def now(self) -> datetime:
        return self._t

    def advance_minutes(self, minutes: float) -> None:
        self._t += timedelta(minutes=minutes)
