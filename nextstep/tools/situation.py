"""updateSituation(): versioned, never overwrites. Each call adds version N+1; old versions stay.
The staleness check for confirmed sends compares against these version numbers."""
from ..views import current_version


def update_situation(store, sid: str, text: str, source: str, changes=None, reason: str = "", pasted: str | None = None) -> dict:
    previous = current_version(store, sid)
    version = previous + 1
    store.append(sid, "situation_version", meta={"version": version, "source": source},
                 data={"text": text, "pasted": pasted, "changes": changes or [], "reason": reason})
    return {"version": version, "previousVersion": previous, "changes": changes or []}
