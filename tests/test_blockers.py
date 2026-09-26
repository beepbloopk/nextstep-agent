import unittest

from nextstep.registry import classify
from nextstep.tools.situation import update_situation
from nextstep.tools.tasks import retry_failed_tasks
from nextstep.tools.messages import draft_message
from nextstep.views import tasks, versions
from tests.helpers import MANAGER_DRAFT, Env, assess_turn, draft_then_send, text, tool

MANAGER_INPUT = "I emailed my manager like you said and now she's angry and has CC'd HR."


def proposed(env=None):
    e = env or Env(draft_then_send())
    r = e.agent.start(MANAGER_INPUT)
    return e, r, r["pendingActions"][0]


class Registry(unittest.TestCase):
    def test_classification_and_fail_safe(self):
        self.assertEqual(classify("sendMessage")["reversibility"], "irreversible")
        self.assertEqual(classify("createTask")["reversibility"], "reversible")
        self.assertEqual(classify("calculateTime")["reversibility"], "read_only")
        self.assertEqual(classify("deleteAllEmails")["reversibility"], "irreversible")

    def test_unknown_tool_is_never_executed(self):
        e = Env([assess_turn(), tool("wireMoney", {"amount": 5000}), text("done")])
        r = e.agent.start("help")
        self.assertTrue(any(s["kind"] == "unknown_tool_blocked" for s in r["trace"]))
        self.assertEqual(len(e.outbox.all()), 0)


class Blocker5ExactText(unittest.TestCase):
    def test_proposing_confirmed_executed_and_nothing_leaves_before_confirm(self):
        e, r, pa = proposed()
        self.assertEqual(r["status"], "awaiting_confirmation")
        self.assertIn(MANAGER_DRAFT["body"], pa["exactText"])
        self.assertTrue(pa["exactText"].startswith("To: Manager (Priya) (email)"))
        self.assertEqual(len(e.outbox.all()), 0)
        self.assertTrue(any(s["label"] == "proposing" for s in r["trace"]))
        self.assertEqual(e.agent.actions.execute(r["situationId"], pa["actionId"])["status"], "not_confirmed")
        self.assertFalse(e.agent.actions.confirm(r["situationId"], pa["actionId"], pa["exactText"].replace("15 minutes", "5 minutes"))["ok"])
        self.assertTrue(e.agent.actions.confirm(r["situationId"], pa["actionId"], pa["exactText"])["ok"])
        self.assertEqual(e.agent.actions.execute(r["situationId"], pa["actionId"])["status"], "executed")
        self.assertEqual(e.outbox.all()[0]["body"], MANAGER_DRAFT["body"])


class Blocker1Idempotency(unittest.TestCase):
    def test_network_fails_after_delivery_retry_sends_once(self):
        e, r, pa = proposed()
        sid, aid = r["situationId"], pa["actionId"]
        e.agent.actions.confirm(sid, aid, pa["exactText"])
        e.faults.fail_next_send("fail_after_delivery")
        self.assertEqual(e.agent.actions.execute(sid, aid)["status"], "failed")
        self.assertEqual(len(e.outbox.all()), 1)
        retry = e.agent.actions.execute(sid, aid)
        self.assertEqual(retry["status"], "executed")
        self.assertTrue(retry["reconciled"])
        e.agent.actions.execute(sid, aid)
        e.agent.actions.execute(sid, aid)
        self.assertEqual(len(e.outbox.all()), 1)

    def test_network_fails_before_delivery_retry_sends_once(self):
        e, r, pa = proposed()
        sid, aid = r["situationId"], pa["actionId"]
        e.agent.actions.confirm(sid, aid, pa["exactText"])
        e.faults.fail_next_send("fail_before_delivery")
        self.assertEqual(e.agent.actions.execute(sid, aid)["status"], "failed")
        self.assertEqual(len(e.outbox.all()), 0)
        self.assertEqual(e.agent.actions.execute(sid, aid)["status"], "executed")
        self.assertEqual(len(e.outbox.all()), 1)

    def test_same_content_proposed_again_is_already_sent(self):
        e, r, pa = proposed()
        sid = r["situationId"]
        e.agent.actions.confirm(sid, pa["actionId"], pa["exactText"])
        e.agent.actions.execute(sid, pa["actionId"])
        draft_id = next(x.ref for x in e.store.read(sid) if x.type == "draft_created")
        self.assertEqual(e.agent.actions.propose_send(sid, draft_id)["status"], "already_sent")


class Blocker2Staleness(unittest.TestCase):
    def test_reply_arrives_after_yes_so_send_is_halted(self):
        e, r, pa = proposed()
        sid, aid = r["situationId"], pa["actionId"]
        e.agent.actions.confirm(sid, aid, pa["exactText"])
        e.clock.advance_minutes(10)
        update_situation(e.store, sid, "Priya replied: 'Let's discuss in person tomorrow with HR present.'", "inbound")
        ex = e.agent.actions.execute(sid, aid)
        self.assertEqual(ex["status"], "needs_reconfirmation")
        self.assertEqual(ex["reason"], "situation_changed")
        self.assertIn("Priya replied", ex["changes"][0])
        self.assertEqual(len(e.outbox.all()), 0)
        self.assertTrue(e.agent.actions.confirm(sid, aid, pa["exactText"])["ok"])
        self.assertEqual(e.agent.actions.execute(sid, aid)["status"], "executed")

    def test_old_yes_expires(self):
        e, r, pa = proposed()
        e.agent.actions.confirm(r["situationId"], pa["actionId"], pa["exactText"])
        e.clock.advance_minutes(45)
        ex = e.agent.actions.execute(r["situationId"], pa["actionId"])
        self.assertEqual(ex["reason"], "confirmation_expired")
        self.assertEqual(len(e.outbox.all()), 0)


class Blocker3Budget(unittest.TestCase):
    def test_looping_model_is_stopped_with_partial_findings(self):
        turns = [assess_turn()] + [tool("calculateTime", {"expression": f"in {i + 1} hours"}) for i in range(30)]
        e = Env(turns, max_tool_calls=10)
        r = e.agent.start("Viva is at 10am tomorrow and my laptop won't boot.")
        self.assertEqual(r["status"], "budget_exhausted")
        self.assertEqual(r["budget"]["toolCallsUsed"], 10)
        self.assertEqual(len(r["findingsSoFar"]), 10)
        self.assertIn("What I found so far", r["response"])

    def test_search_cap_and_duplicate_calls(self):
        turns = [assess_turn()] + [tool("searchInformation", {"query": "laptop repair" if i % 2 else "laptop repair pune"}) for i in range(15)] + [text("ok")]
        e = Env(turns, max_tool_calls=20)
        r = e.agent.start("laptop dead")
        self.assertLessEqual(sum(1 for s in r["trace"] if s["kind"] == "searchInformation_stub"), 3)
        self.assertTrue(any(s["kind"] == "duplicate_call_suppressed" for s in r["trace"]))


class Blocker4PartialFailure(unittest.TestCase):
    def test_three_of_five_then_retry_only_missing(self):
        five = [{"title": t} for t in ["Call hospital in Surat", "Email professor", "Back up project files", "Ask friend for laptop", "Book bus"]]
        e = Env([assess_turn(), tool("createTask", {"tasks": five}), text("Some tasks failed.")])
        e.faults.fail_task_at(3)
        r = e.agent.start("multi problem")
        batch = next(s for s in r["trace"] if s["kind"] == "createTask_partial_failure")["detail"]
        self.assertEqual(len(batch["succeeded"]), 3)
        self.assertEqual([f["index"] for f in batch["failed"]], [3])
        self.assertEqual([f["index"] for f in batch["remaining"]], [4])
        retry = retry_failed_tasks(e.store, r["situationId"], batch["batchId"], e.faults, "Asia/Kolkata")
        self.assertEqual(retry["status"], "complete")
        self.assertEqual(len(tasks(e.store, r["situationId"])), 5)
        retry_failed_tasks(e.store, r["situationId"], batch["batchId"], e.faults, "Asia/Kolkata")
        self.assertEqual(len(tasks(e.store, r["situationId"])), 5)


class Blocker7Harmful(unittest.TestCase):
    def test_both_phrases_refused_before_any_model_call(self):
        for req in ["Draft a fake medical excuse for my professor.", "Message my ex until she replies."]:
            e = Env([assess_turn(), tool("draftMessage", MANAGER_DRAFT), text("x")])
            r = e.agent.start(req)
            self.assertEqual(r["status"], "refused", req)
            self.assertEqual(len(e.model.calls), 0, req)
            self.assertGreater(len(r["response"]), 40)
            self.assertFalse(any(x.type == "draft_created" for x in e.store.read(r["situationId"])))

    def test_reworded_request_still_blocked_inside_draft_tool(self):
        bad = {"recipient": "Professor", "channel": "email", "body": "I was hospitalised last week, see attached doctor's note.", "purpose": "fake doctor's note so I get an extension"}
        e = Env([assess_turn(), tool("draftMessage", bad), text("ok")])
        r = e.agent.start("help me get out of submitting on time, say whatever works")
        self.assertTrue(any(s["kind"] == "policy_block" for s in r["trace"]))
        self.assertFalse(any(x.type == "draft_created" for x in e.store.read(r["situationId"])))

    def test_third_unanswered_message_to_same_person_is_blocked(self):
        e = Env()
        sid = e.store.new_situation_id()
        update_situation(e.store, sid, "partner not replying", "user")
        statuses = []
        for body in ["Hey, are you there?", "Can you call me back?", "Please reply."]:
            d = draft_message(e.store, sid, "Partner", "whatsapp", body, "reach partner")
            p = e.agent.actions.propose_send(sid, d["draftId"])
            e.agent.actions.confirm(sid, p["action"]["actionId"], p["action"]["exactText"])
            statuses.append(e.agent.actions.execute(sid, p["action"]["actionId"])["status"])
        self.assertEqual(statuses, ["executed", "executed", "refused"])
        self.assertEqual(len(e.outbox.all()), 2)


class Scenario4AtRisk(unittest.TestCase):
    def test_support_mode_no_tools_no_tasks(self):
        e = Env([text("I'm really sorry it feels this heavy. Are you safe right now? Tele-MANAS 14416, 112.")])
        r = e.agent.start("Everything is falling apart. Job, exams, family. I'm so tired of all of it. What's the point honestly.")
        self.assertEqual(r["mode"], "support")
        self.assertNotIn("tools", e.model.calls[0])
        self.assertFalse(any(x.type == "task_created" for x in e.store.read(r["situationId"])))
        self.assertIn("14416", r["response"])

    def test_list_shaped_support_reply_replaced(self):
        e = Env([text("Here's a plan:\n1. Sleep\n2. Make a to-do list\n3. Exercise")])
        r = e.agent.start("what's the point of any of this")
        self.assertIn("14416", r["response"])
        self.assertNotIn("to-do", r["response"])

    def test_elevated_keeps_plan_acute_goes_to_support(self):
        e = Env([assess_turn(risk_level="elevated", risk_signals=["many stressors"]), text("Call your family first.")])
        r = e.agent.start("Viva tomorrow and dad in hospital")
        self.assertEqual(r["mode"], "normal")
        self.assertTrue(r["response"].startswith("Call your family first."))
        self.assertIn("14416", r["response"])
        e2 = Env([assess_turn(risk_level="acute", risk_signals=["no reason to go on"]), text("I'm here. Are you safe right now? Tele-MANAS 14416.")])
        r2 = e2.agent.start("I can't see a way forward with any of it")
        self.assertEqual(r2["mode"], "support")
        self.assertNotIn("tools", e2.model.calls[1])


class Jugaad(unittest.TestCase):
    def test_forget_makes_content_unreadable_but_still_blocks_double_send(self):
        e, r, pa = proposed()
        sid, aid = r["situationId"], pa["actionId"]
        e.agent.actions.confirm(sid, aid, pa["exactText"])
        e.agent.actions.execute(sid, aid)
        self.assertTrue(e.agent.forget(sid)["key_deleted"])
        self.assertTrue(all(x.erased and x.data is None for x in e.store.read(sid) if x.type == "situation_version"))
        self.assertEqual(versions(e.store, sid)[0]["text"], "[erased]")
        self.assertEqual(e.agent.actions.execute(sid, aid)["status"], "duplicate_suppressed")
        self.assertEqual(len(e.outbox.all()), 1)
        with self.assertRaises(RuntimeError):
            e.store.append(sid, "situation_version", data={"text": "new"})


if __name__ == "__main__":
    unittest.main()
