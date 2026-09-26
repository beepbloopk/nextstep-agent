"""Chat with the agent in the terminal:  python -m nextstep.cli   (add --autopilot to skip questions)

The confirmation prompt lives HERE, outside the AI: the AI can only propose a send; this code shows
the exact text and records the user's answer.
"""
import os
import sys

from . import config
from .agent import NextStepAgent
from .clock import SystemClock
from .model import GeminiModel
from .store import SituationStore
from .tools.messages import MockOutbox
from .trace import drafts_in


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    if not config.API_KEY:
        print("GEMINI_API_KEY is not set. Put it in a .env file (see .env.example). Tests that need no key: python -m unittest")
        return
    store = SituationStore(config.DATA_DIR, SystemClock())
    show_trace = bool(os.environ.get("NEXTSTEP_SHOW_TRACE"))
    agent = NextStepAgent(store, GeminiModel(config.MODEL, config.API_KEY), MockOutbox(config.DATA_DIR), autopilot="--autopilot" in sys.argv,
                          on_step=(lambda s: print(f"  [{s['label']}] {s['kind']}: {s['summary'].splitlines()[0][:120]}")) if show_trace else None)

    def show(r: dict) -> None:
        print(f"\n{r['response']}\n")
        for n in r["notices"]:
            print(f"  (done) {n}")
        for d in drafts_in(r["trace"]):
            print(f"\n  Draft {d['draftId']} (saved, NOT sent) to {d['recipient']} via {d['channel']}:")
            if d.get("subject"):
                print(f"  Subject: {d['subject']}")
            print("\n".join("  | " + line for line in d["body"].splitlines()))

    def send(sid: str, action_id: str) -> None:
        ex = agent.actions.execute(sid, action_id)
        while ex["status"] == "failed":
            print(f"  {ex['note']}")
            if input("  Retry? (y/n): ").strip().lower() != "y":
                return
            ex = agent.actions.execute(sid, action_id)
        messages = {"executed": f"  Sent ({ex.get('providerMessageId')}).", "duplicate_suppressed": f"  {ex.get('note')}",
                    "needs_reconfirmation": "  Something changed since you said yes, so I did not send it. Let's look again."}
        print(messages.get(ex["status"], f"  {ex.get('refusal', {}).get('explanation', ex['status'])}"))

    def handle_pending(r: dict) -> None:
        pending = [p for p in r["pendingActions"] if p["exactText"]]
        if not pending:
            return
        print("\n  ------------------------------------------------------------")
        print(f"  NextStep wants to SEND {'this message' if len(pending) == 1 else f'these {len(pending)} messages'}. Sending cannot be undone.")
        print("  ------------------------------------------------------------")
        for i, p in enumerate(pending, 1):
            print(f"\n  [{i}]")
            print("\n".join("  | " + line for line in p["exactText"].splitlines()))
            if p["warnings"]:
                print(f"  WARNING: this still contains {p['warnings']}. It would be sent exactly like that.")
        prompt = ("\n  Send exactly this? Type 'send' to send, anything else to keep it as a draft: " if len(pending) == 1
                  else "\n  Type 'send all' to send every message above, a number to send just that one, anything else to keep them as drafts: ")
        ans = input(prompt).strip().lower()
        if ans in ("send", "send all"):
            chosen = pending
        elif ans.isdigit() and 1 <= int(ans) <= len(pending):
            chosen = [pending[int(ans) - 1]]
        else:
            chosen = []
        for p in pending:
            if p not in chosen:
                agent.actions.cancel(r["situationId"], p["actionId"])
        if not chosen:
            print("  Nothing sent. Drafts are kept.")
            return
        # One yes for the batch; every text shown is still checked against its proposal.
        c = agent.actions.confirm_many(r["situationId"], [{"actionId": p["actionId"], "shownText": p["exactText"]} for p in chosen])
        if not c["ok"]:
            print(f"  Could not confirm: {c['error']}")
            return
        for p in chosen:
            send(r["situationId"], p["actionId"])

    print("NextStep. Tell me what's going on. Commands: 'update: <what changed>', 'autopilot on|off', 'forget', 'quit'.")
    if agent.autopilot:
        print("Autopilot is ON: I won't ask questions, I'll just act. I will still show you any message before it is sent.")
    sid = None
    while True:
        line = input("> " if sid else "What's going on? ").strip()
        if not line:
            continue
        if line == "quit":
            break
        if line in ("autopilot on", "autopilot off"):
            agent.autopilot = line.endswith("on")
            print("Autopilot on. I'll stop asking and tell you what I assumed. Messages to people still need your OK." if agent.autopilot
                  else "Autopilot off. I'll ask when an answer changes what I do.")
            continue
        if line == "forget" and sid:
            agent.forget(sid)
            print("Deleted: your situation text, drafts and traces are no longer readable. Only non-private bookkeeping remains (see README, Jugaad).")
            sid = None
            continue
        if not sid:
            pasted = input("Paste a forwarded message if there is one (or press Enter): ").strip()
            r = agent.start(line, pasted=pasted or None)
            sid = r["situationId"]
        elif line.startswith("update:"):
            r = agent.reassess(sid, line[7:].strip(), "user")
        else:
            r = agent.answer(sid, line)
        show(r)
        handle_pending(r)


if __name__ == "__main__":
    main()
