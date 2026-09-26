"""Curveball evidence: the contradictory scenario with autopilot ON (the normal run asked a question).
Run: python scripts/curveball_autopilot.py"""
from datetime import datetime, timezone

from common import ROOT, live_agent, render_run, require_key

INPUT = "My deadline is Friday… actually wait, I think the professor said Thursday. I have no savings but I can probably borrow from my roommate, although we're not talking right now."


def main() -> None:
    require_key()
    agent, *_ = live_agent("curveball", autopilot=True)
    r = agent.start(INPUT)
    (ROOT / "results" / "curveball-autopilot.md").write_text("\n".join([
        "# Curveball: autopilot run", "",
        f"Run at {datetime.now(timezone.utc).isoformat()}. Same input as [scenario 3](scenarios/s3_contradictory.md), where the normal agent stopped to ask which deadline was right. Here autopilot is on.", "",
        f"> {INPUT}", "", render_run(r),
    ]) + "\n", encoding="utf-8")
    print(r["status"], r["modelsUsed"], "\n" + r["response"])


if __name__ == "__main__":
    main()
