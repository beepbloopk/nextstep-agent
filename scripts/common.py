"""Shared helpers for the scripts: live agent setup, scenario loading, Markdown rendering."""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from nextstep import config  # noqa: E402
from nextstep.agent import NextStepAgent  # noqa: E402
from nextstep.clock import SystemClock  # noqa: E402
from nextstep.faults import Faults  # noqa: E402
from nextstep.model import GeminiModel  # noqa: E402
from nextstep.store import SituationStore  # noqa: E402
from nextstep.tools.messages import MockOutbox  # noqa: E402
from nextstep.trace import drafts_in  # noqa: E402


def require_key() -> None:
    if not config.API_KEY:
        print("GEMINI_API_KEY is not set. Put it in a .env file (see .env.example). Tests that need no key: python -m unittest")
        sys.exit(1)


def live_agent(subdir: str, autopilot: bool = False):
    d = config.DATA_DIR / subdir
    store = SituationStore(d, SystemClock())
    faults = Faults()
    outbox = MockOutbox(d)
    agent = NextStepAgent(store, GeminiModel(config.MODEL, config.API_KEY), outbox, faults, autopilot=autopilot)
    return agent, store, faults, outbox


def load_scenarios() -> tuple[list[dict], str]:
    """The mock API is deliberately unreliable: timeout, 3 tries with backoff, shape check, then a
    local copy (scenarios/shared-scenarios.json) so a flaky API never blocks a run."""
    url = f"{config.MOCK_API_BASE}/v1/scenarios"
    headers = {"X-Candidate-Id": config.CANDIDATE_ID} if config.CANDIDATE_ID else {}
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=15) as resp:
                items = json.loads(resp.read().decode("utf-8")).get("scenarios")
            if isinstance(items, list) and len(items) == 7 and all(s.get("id") and s.get("input") for s in items):
                return items, f"{url} (attempt {attempt})"
            raise ValueError("unexpected shape")
        except Exception as err:  # noqa: BLE001
            print(f"scenario fetch attempt {attempt} failed: {err}")
            if attempt < 3:
                time.sleep(attempt * 2)
    local = json.loads((ROOT / "scenarios" / "shared-scenarios.json").read_text(encoding="utf-8"))
    return local["scenarios"], "scenarios/shared-scenarios.json (local fallback; API unavailable)"


def render_run(r: dict, heading: str | None = None) -> str:
    out = [heading, ""] if heading else []
    models = " + ".join(r.get("modelsUsed") or []) or "none (answered by the plain-code policy)"
    out.append(f"- status: `{r['status']}`, mode: `{r['mode']}`, tool calls: {r['budget']['toolCallsUsed']}/{r['budget']['maxToolCalls']}, model: {models}")
    p = r.get("priority")
    if p:
        top = "TIE: " + " / ".join(t["title"] for t in p["top"]) if p["tie"] else p["top"][0]["title"]
        out.append(f"- top priority (code-ranked): **{top}** (AI's own pick {'agrees' if p['agreesWithModel'] else 'differs'})")
    a = r.get("assessment")
    if a:
        out.append("- understood: " + "; ".join(f"{x['title']} [{x['category']}/{x['urgency']}]" for x in a.get("problems", [])))
        if a.get("contradictions"):
            out.append("- contradictions: " + "; ".join(f"{c['about']}: {' vs '.join(c['statements'])} -> provisional: {c['provisional_choice']}" for c in a["contradictions"]))
        if a.get("missing_info"):
            out.append("- missing info: " + "; ".join(a["missing_info"]))
    if r["notices"]:
        out.append("- actions taken: " + " ".join(r["notices"]))
    out += ["", "**Agent reply:**", ""] + [f"> {line}" for line in r["response"].splitlines()]
    pending_texts = {p["exactText"] for p in r["pendingActions"]}
    for d in drafts_in(r["trace"]):
        t = "\n".join([f"To: {d['recipient']} ({d['channel']})"] + ([f"Subject: {d['subject']}"] if d.get("subject") else []) + ["", d["body"]])
        if t not in pending_texts:
            out += ["", f"**Draft saved ({d['draftId']}), not sent, shown to the user:**", "", "```text", t, "```"]
    for pa in r["pendingActions"]:
        out += ["", f"**Waiting for the user's yes ({pa['actionId']}), exact text the user sees:**", "", "```text", pa["exactText"] or "", "```"]
        if pa.get("warnings"):
            out += ["", f"Warning shown with it: unfilled placeholder(s) {pa['warnings']}."]
    steps = [f"{s['step']}. [{s['label']}] {s['kind']}: {s['summary'].splitlines()[0][:160]}" for s in r["trace"] if s["kind"] != "model_reasoning"]
    out += ["", "<details><summary>Trace (labelled steps)</summary>", "", "```text", *steps, "```", "", "</details>"]
    return "\n".join(out)
