"""Settings, read from environment variables and an optional .env file (no dotenv dependency)."""
import os
from pathlib import Path


def _load_env_file() -> None:
    path = Path.cwd() / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file()


def _int(name: str, default: int) -> int:
    try:
        n = int(os.environ.get(name, ""))
        return n if n > 0 else default
    except ValueError:
        return default


# Model names change over time, so they come from env. GEMINI_MODEL may be a comma-separated
# fallback chain: when one model's free daily quota runs out, the next one is used.
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite"
API_KEY = os.environ.get("GEMINI_API_KEY", "")
TIMEZONE = os.environ.get("NEXTSTEP_TZ", "Asia/Kolkata")
DATA_DIR = Path(os.environ.get("NEXTSTEP_DATA_DIR", "./data")).resolve()
CANDIDATE_ID = os.environ.get("NEXTSTEP_CANDIDATE_ID", "")
MOCK_API_BASE = "https://nextstepmockapi.onrender.com"

# Budgets (blocker 3)
MAX_TOOL_CALLS = _int("NEXTSTEP_MAX_TOOL_CALLS", 10)
MAX_MODEL_TURNS = MAX_TOOL_CALLS + 2  # above the tool cap, so the tool cap is what normally bites
MAX_SEARCHES = 3

# Staleness (blocker 2): a yes older than this has expired.
CONFIRMATION_TTL_SECONDS = 30 * 60
