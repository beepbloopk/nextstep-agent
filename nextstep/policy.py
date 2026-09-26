"""The agent's own safety rules (blocker 7, and the at-risk path for scenario 4).

Plain-code rules run BEFORE the AI is called, and again inside draftMessage / sendMessage. They are
narrow on purpose: they catch the clear cases instantly and explainably. Rewordings that slip past
are caught by the AI's assessment (request_type = "harmful", risk_level = "acute").
"""
import re

REQUEST_RULES = [
    {
        "category": "deception_forgery",
        "re": re.compile(
            r"\b(fake|forged?|made[- ]?up|false|bogus|fabricated?|phony|nakli|jhoota)\b[^.\n]{0,25}\b(medical|doctor'?s?|sick|illness|hospital|certificate|excuse|note|leave letter|prescription)\b"
            r"|\b(pretend|lie|say|claim)\b[^.\n]{0,20}\b(i was|i am|i'm|that i)\b[^.\n]{0,15}\b(sick|ill|hospitali[sz]ed|unwell)\b",
            re.I,
        ),
        "explanation": "I can't draft a fake medical excuse. It is a false document, and if it is checked it can turn a missed deadline into a disciplinary case.",
        "alternative": "I can help you write an honest message to your professor asking for an extension, saying you fell behind and proposing a new date. Honest requests work more often than people expect.",
    },
    {
        "category": "harassment",
        "re": re.compile(
            r"\b(message|text|call|dm|ping|spam|keep (?:messaging|texting|calling))\b[^.\n]{0,30}\b(until|till|untill|repeatedly|non-?stop|again and again|every (?:hour|day|minute))\b"
            r"|\buntil (she|he|they) (replies|responds|answers|picks up|talks)\b",
            re.I,
        ),
        "explanation": "I won't keep messaging someone until they reply. When a person is not responding, repeated messages usually feel like pressure, and they can cross into harassment.",
        "alternative": "If you want, I can help you write one clear, calm message that says what you need to say and leaves the choice to reply with them. Or we can talk through how you're feeling about the silence.",
    },
    {
        "category": "credential_phishing",
        "re": re.compile(r"\b(get|ask|make|trick|convince)\b[^.\n]{0,30}\b(their|his|her|someone'?s)\b[^.\n]{0,20}\b(upi\s*pin|pin|otp|password|cvv)\b", re.I),
        "explanation": "I can't help get someone else's PIN, OTP or password. That is how most UPI fraud works.",
        "alternative": "If you are worried about a payment or an account, I can help you contact the bank or report it on 1930.",
    },
]


def screen_request(text: str) -> dict | None:
    for rule in REQUEST_RULES:
        m = rule["re"].search(text)
        if m:
            return {"category": rule["category"], "matched": m.group(0), "explanation": rule["explanation"], "alternative": rule["alternative"]}
    return None


ACUTE = re.compile(
    r"\b(kill myself|end (it all|my life)|suicid\w*|want to die|wanna die|don'?t want to (live|be alive|exist)|no reason to live|better off without me"
    r"|want it all to stop|hurt myself|self[- ]harm|mar jaana|marna chahta|marna chahti|jeena nahi|khatam kar (dun|doon|lu|loon))\b",
    re.I,
)
ELEVATED = re.compile(
    r"\b(what'?s the point|whats the point|what is the point|so tired of (it|all|everything)|tired of all of it|can'?t (do|take) (this|it) anymore"
    r"|give up on everything|nothing matters|everything is falling apart|hopeless|no way out|koi fayda nahi|sab khatam)\b",
    re.I,
)


def screen_risk(text: str) -> dict:
    signals = []
    a, e = ACUTE.search(text), ELEVATED.search(text)
    if a:
        signals.append(a.group(0))
    if e:
        signals.append(e.group(0))
    return {"level": "acute" if a else "elevated" if e else "none", "signals": signals}


def check_outgoing_message(body: str, purpose: str) -> dict | None:
    """Second gate, inside draftMessage/sendMessage, on the actual message and its stated purpose."""
    r = screen_request(f"{purpose}\n{body}")
    if r:
        return r
    if re.search(r"\b(share|send|give|tell)\b[^.\n]{0,30}\b(upi\s*pin|otp|password|cvv)\b", body, re.I):
        return {
            "category": "credential_phishing",
            "matched": "message asks the recipient for a secret",
            "explanation": "This message asks someone to share a PIN, OTP or password. I won't send that.",
            "alternative": "Rewrite the message without asking for any secret.",
        }
    return None


# Stops "message them until they reply" in code, even when it is phrased politely.
MAX_UNANSWERED_PER_RECIPIENT = 2
