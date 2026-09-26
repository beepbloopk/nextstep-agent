"""The AI lists the problems; plain CODE ranks them (blocker 8).

Same list in, same order out, and the score explains "why this first" without trusting the AI's
own pick. Ties are reported as ties instead of inventing an order.
"""
from .tools.calculate_time import calculate_time

URGENCY = {"critical": 40, "high": 30, "medium": 20, "low": 10}
# People's safety and health first, then fraud, then things with hard external deadlines.
CATEGORY = {"health_family": 40, "safety_fraud": 35, "academic": 15, "work": 15, "housing": 15, "money": 12, "tech": 10, "relationship": 8, "other": 5}


def rank_problems(assessment: dict, now, tz: str) -> dict:
    ranked = []
    for p in assessment.get("problems", []):
        reasons, score = [], 0
        u = URGENCY.get(p.get("urgency"), 10)
        c = CATEGORY.get(p.get("category"), 5)
        score += u + c
        reasons += [f"urgency {p.get('urgency')} (+{u})", f"category {p.get('category')} (+{c})"]
        if p.get("deadline_text"):
            t = calculate_time(p["deadline_text"], now, tz)
            mins = t.get("minutesRemaining")
            if mins is not None and not t["alreadyPassed"]:
                if mins <= 24 * 60:
                    score += 20
                    reasons.append(f"deadline within 24h: {t['resolved']['local']} (+20)")
                elif mins <= 72 * 60:
                    score += 10
                    reasons.append(f"deadline within 72h: {t['resolved']['local']} (+10)")
        ranked.append({"id": p.get("id"), "title": p.get("title"), "score": score, "reasons": reasons})
    ranked.sort(key=lambda r: (-r["score"], str(r["id"])))
    best = ranked[0]["score"] if ranked else 0
    top = [r for r in ranked if r["score"] == best]
    pick = (assessment.get("top_priority") or {}).get("problem_id", "")
    return {"ranked": ranked, "top": top, "tie": len(top) > 1, "modelPick": pick, "agreesWithModel": any(t["id"] == pick for t in top)}
