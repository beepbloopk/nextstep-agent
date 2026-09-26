import json
import tempfile
from pathlib import Path

from nextstep.agent import NextStepAgent
from nextstep.clock import FakeClock
from nextstep.faults import Faults
from nextstep.model import ScriptedModel, fake_reply, text, tool
from nextstep.store import SituationStore
from nextstep.tools.messages import MockOutbox


class Env:
    def __init__(self, turns=(), start="2026-09-26T20:00:00+05:30", max_tool_calls=None, autopilot=False):
        self.dir = Path(tempfile.mkdtemp(prefix="nextstep-"))
        self.clock = FakeClock(start)
        self.store = SituationStore(self.dir, self.clock)
        self.outbox = MockOutbox(self.dir)
        self.faults = Faults()
        self.model = ScriptedModel(list(turns))
        self.agent = NextStepAgent(self.store, self.model, self.outbox, self.faults, max_tool_calls=max_tool_calls, autopilot=autopilot)


def assessment(**over) -> dict:
    a = {
        "language": "English",
        "request_type": "situation_help",
        "risk_level": "none",
        "risk_signals": [],
        "problems": [{"id": "p1", "title": "Reply to manager", "category": "work", "urgency": "high", "deadline_text": None, "facts": ["manager angry", "HR cc'd"]}],
        "contradictions": [],
        "missing_info": [],
        "untrusted_instructions_seen": [],
        "top_priority": {"problem_id": "p1", "next_action": "draft a calm reply", "why": "HR is involved"},
    }
    a.update(over)
    return a


def assess_turn(**over) -> dict:
    return fake_reply([{"type": "tool_use", "name": "recordAssessment", "input": assessment(**over)}])


MANAGER_DRAFT = {
    "recipient": "Manager (Priya)",
    "channel": "email",
    "subject": "Re: yesterday's email",
    "body": "Hi Priya, I'm sorry my email came across badly. That wasn't my intent. Could we talk for 15 minutes today? I'd like to understand your concerns and fix this. Thanks, Karishma",
    "purpose": "calm reply to manager after escalation",
}


def draft_then_send(draft=MANAGER_DRAFT, final="I've drafted a calm reply. Please read it before anything is sent."):
    """Model turns: assess, draft, then propose sending the draft id it got back."""

    def send_step(request):
        draft_id = json.loads(request["messages"][-1]["content"][0]["content"])["draftId"]
        return tool("sendMessage", {"draft_id": draft_id})

    return [assess_turn(), tool("draftMessage", draft), send_step, text(final)]


__all__ = ["Env", "assessment", "assess_turn", "draft_then_send", "MANAGER_DRAFT", "text", "tool"]
