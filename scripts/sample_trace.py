"""One full run of scenario 7 in ONE trace: understand, reason, ask, answer, draft, propose the send,
the user sees the exact text and says yes, the network fails after delivery, the retry does NOT send
twice, then the manager replies and the agent reassesses.

The "user" is scripted (fixed answers; says yes by echoing the exact text it was shown). Everything
the agent does is the live AI plus the real code.   Run: python scripts/sample_trace.py
"""
from datetime import datetime, timezone

from common import ROOT, live_agent, require_key
from nextstep.trace import Trace

INPUT = "I emailed my manager like you said and now she's angry and has CC'd HR."
ANSWER = ("I told her the deadline she set was unrealistic and cc'd the whole team. She replied that my tone was unprofessional and added HR. "
          "Her name is Priya, my name is Karishma. I want to fix this without making it worse.")
NUDGE = "Please write a short reply to Priya and send it for me. Show me the exact text before it goes."


def main() -> None:
    require_key()
    agent, store, faults, outbox = live_agent("sample-trace")
    trace = Trace("sample_run", "", store.clock, lambda s: print(f"{s['step']}. [{s['label']}] {s['phase']}/{s['kind']}: {s['summary'].splitlines()[0][:140]}"))
    r = agent.start(INPUT, trace=trace)
    sid = r["situationId"]
    convo = [f"USER: {INPUT}", f"AGENT: {r['response']}"]
    for reply in (ANSWER, NUDGE, NUDGE):
        if r["pendingActions"]:
            break
        convo.append(f"USER (scripted): {reply}")
        r = agent.answer(sid, reply, trace)
        convo.append(f"AGENT: {r['response']}")

    pending = r["pendingActions"]
    if not pending:
        # The AI only saved a draft. The user can still choose to send a saved draft from the app;
        # that goes through the very same propose -> confirm -> execute path.
        saved = [x for x in agent.store.read(sid) if x.type == "draft_created"]
        if saved:
            convo.append(f"USER (scripted): taps 'send' on the saved draft {saved[-1].ref}")
            p = agent.actions.propose_send(sid, saved[-1].ref, trace)
            pending = [p["action"]] if p["status"] == "proposed" else []

    if pending:
        pa = pending[0]
        convo += [f"SHOWN TO USER BEFORE SENDING:\n{pa['exactText']}", "USER (scripted): yes, send exactly this"]
        assert agent.actions.confirm(sid, pa["actionId"], pa["exactText"], trace)["ok"]
        faults.fail_next_send("fail_after_delivery")
        first = agent.actions.execute(sid, pa["actionId"], trace)
        convo.append(f"SEND ATTEMPT 1: {first['status']} ({first.get('error', '')})")
        retry = agent.actions.execute(sid, pa["actionId"], trace)
        convo.append(f"SEND ATTEMPT 2 (user tapped retry): {retry['status']}" + (" (found in the outbox, not sent again)" if retry.get("reconciled") else ""))
        key = agent.actions.get(sid, pa["actionId"])["idempotencyKey"]
        convo.append(f"OUTBOX now holds {sum(1 for m in outbox.all() if m['clientRef'] == key)} copy of this message.")
        reply = "Priya replied: 'Thanks for this. Let's meet tomorrow at 11am with HR to reset expectations.'"
        convo.append(f"INBOUND: {reply}")
        r = agent.reassess(sid, reply, "inbound", trace)
        convo.append(f"AGENT: {r['response']}")
    else:
        print("The agent did not propose a send in this run; the trace is saved anyway.")

    out = ROOT / "traces"
    trace.save(out / "sample-run-scenario7.json")
    counts: dict[str, int] = {}
    for s in trace.steps:
        counts[s["label"]] = counts.get(s["label"], 0) + 1
    rows = [f"| {s['step']} | {s['label']} | {s['phase']} | {s['kind']} | {s['summary'].splitlines()[0].replace('|', '/')[:180]} |" for s in trace.steps]
    (out / "sample-run-scenario7.md").write_text("\n".join([
        "# Sample run: scenario 7 (advice made things worse)", "",
        f"Run at {datetime.now(timezone.utc).isoformat()}. Full labelled trace: [sample-run-scenario7.json](sample-run-scenario7.json).", "",
        "Label counts: " + ", ".join(f"{k}={v}" for k, v in counts.items()), "", "## Conversation", "", "```text", *convo, "```", "",
        "## Steps", "", "| # | label | phase | kind | summary |", "|---|---|---|---|---|", *rows,
    ]) + "\n", encoding="utf-8")
    print("\nSaved traces/sample-run-scenario7.json and .md")


if __name__ == "__main__":
    main()
