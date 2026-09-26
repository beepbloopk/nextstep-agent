"""Blocker 8: same input 5 times. Does the same top priority come back?

Priority is decided in the first AI call (Understand + Reason), so these runs stop there. That keeps
the check to 5 requests on the free tier.   Run: python scripts/determinism.py
"""
import json
import sys
from datetime import datetime, timezone

from common import ROOT, live_agent, require_key

INPUT = "Viva is at 10am tomorrow, laptop won't boot, my project partner has been ignoring my calls for 2 days, and my dad just got admitted to a hospital in Surat. I'm in Pune."


def main() -> None:
    require_key()
    text_in = sys.argv[1] if len(sys.argv) > 1 else INPUT
    agent, *_ = live_agent("determinism")
    rows = []
    for i in range(1, 6):
        r = agent.assess(text_in)
        a, p = r["assessment"] or {}, r["priority"]
        probs = {x["id"]: x for x in a.get("problems", [])}
        top = p["top"][0] if p else {}
        pick = probs.get((a.get("top_priority") or {}).get("problem_id"), {})
        rows.append({"run": i, "model": "+".join(r["modelsUsed"]), "codeTop": top.get("title", "-"), "codeTopCategory": probs.get(top.get("id"), {}).get("category", "-"),
                     "aiPick": pick.get("title", "-"), "aiPickCategory": pick.get("category", "-"), "nextAction": (a.get("top_priority") or {}).get("next_action", "-")})
        print(rows[-1])
    same = lambda k: len({r[k] for r in rows}) == 1  # noqa: E731
    verdict = {"codeTopCategoryStable": same("codeTopCategory"), "aiPickCategoryStable": same("aiPickCategory"), "sameModelAllRuns": same("model")}
    (ROOT / "results" / "determinism.json").write_text(json.dumps({"input": text_in, "temperature": 0, "runs": rows, "verdict": verdict}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (ROOT / "results" / "determinism.md").write_text("\n".join([
        "# Same input, 5 runs (blocker 8)", "", f"Temperature 0, 5 fresh runs, run at {datetime.now(timezone.utc).isoformat()}.", "", f"> {text_in}", "",
        "| run | model | top priority (ranked by code) | category | AI's own pick | category | AI's suggested next action |", "|---|---|---|---|---|---|---|",
        *[f"| {r['run']} | {r['model']} | {r['codeTop']} | {r['codeTopCategory']} | {r['aiPick']} | {r['aiPickCategory']} | {r['nextAction']} |" for r in rows], "",
        f"- Code's top priority the same every time: **{verdict['codeTopCategoryStable']}**",
        f"- AI's own pick the same every time: **{verdict['aiPickCategoryStable']}**",
        f"- Same model for all runs: **{verdict['sameModelAllRuns']}**", "",
        "Titles are free text written by the AI, so runs are compared by category, not wording.",
    ]) + "\n", encoding="utf-8")
    print(verdict)


if __name__ == "__main__":
    main()
