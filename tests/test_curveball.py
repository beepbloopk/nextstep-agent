"""Curveball: "Users are annoyed by confirmations. Just do everything, stop asking me." """
import unittest

from nextstep.actions import find_placeholders
from tests.helpers import MANAGER_DRAFT, Env, assess_turn, draft_then_send, text, tool


class Autopilot(unittest.TestCase):
    def test_no_askUser_offered_and_prompt_says_autopilot(self):
        e = Env([assess_turn(), text("Assumed: deadline is Thursday. Created your plan.")], autopilot=True)
        r = e.agent.start("deadline friday or thursday?")
        offered = [t["name"] for t in e.model.calls[1]["tools"]]
        self.assertNotIn("askUser", offered)
        self.assertIn("AUTOPILOT IS ON", e.model.calls[1]["system"])
        self.assertEqual(r["status"], "completed")

    def test_question_asked_anyway_is_suppressed_and_run_continues(self):
        e = Env([assess_turn(), tool("askUser", {"questions": ["Which day?"], "why": "x"}), text("Assumed: Thursday.")], autopilot=True)
        r = e.agent.start("deadline friday or thursday?")
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["questions"], [])
        self.assertTrue(any(s["kind"] == "autopilot_question_suppressed" for s in r["trace"]))

    def test_autopilot_never_sends_without_exact_text_yes(self):
        e = Env(draft_then_send(), autopilot=True)
        r = e.agent.start("manager angry, just handle it, stop asking me")
        self.assertEqual(r["status"], "awaiting_confirmation")
        self.assertEqual(len(e.outbox.all()), 0)
        self.assertEqual(e.agent.actions.execute(r["situationId"], r["pendingActions"][0]["actionId"])["status"], "not_confirmed")
        self.assertEqual(len(e.outbox.all()), 0)

    def test_batch_yes_is_all_or_nothing(self):
        e = Env(draft_then_send(), autopilot=True)
        r = e.agent.start("handle it")
        p = r["pendingActions"][0]
        sid = r["situationId"]
        self.assertFalse(e.agent.actions.confirm_many(sid, [{"actionId": p["actionId"], "shownText": p["exactText"] + "!"}])["ok"])
        self.assertEqual(e.agent.actions.get(sid, p["actionId"])["status"], "proposed")
        self.assertTrue(e.agent.actions.confirm_many(sid, [{"actionId": p["actionId"], "shownText": p["exactText"]}])["ok"])
        self.assertEqual(e.agent.actions.execute(sid, p["actionId"])["status"], "executed")

    def test_placeholders_are_flagged(self):
        self.assertEqual(find_placeholders("Best regards,\n[Your Name]"), ["[Your Name]"])
        self.assertEqual(find_placeholders("See you on {{date}} at <Meeting Room>"), ["{{date}}", "<Meeting Room>"])
        self.assertEqual(find_placeholders("I'll send [the slides] tonight"), [])
        e = Env(draft_then_send({**MANAGER_DRAFT, "body": "Hi Priya, sorry about my email.\n\nBest regards,\n[Your Name]"}), autopilot=True)
        self.assertEqual(e.agent.start("handle it")["pendingActions"][0]["warnings"], "[Your Name]")


if __name__ == "__main__":
    unittest.main()
