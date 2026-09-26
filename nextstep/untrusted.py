"""Prompt-injection defense (blocker 6).

Pasted text, forwarded messages, replies from other people, and everything searchInformation()
returns are DATA. Three layers, none of which relies on the AI alone:
  1. wrap_untrusted(): fences the content in tags the system prompt defines as data-only, and
     stops the content from closing the fence early.
  2. scan_for_instructions(): flags instruction-shaped text so the trace records it and the AI is
     told plainly what was flagged.
  3. guard_output(): checks the final reply. Even if the AI were fooled, a reply that asks the user
     to share a PIN / OTP / password is blocked before the user sees it.
"""
import re

INSTRUCTION_PATTERNS = [
    ("fake_system_prefix", re.compile(r"(^|\n|\s)(system|assistant|developer)\s*:", re.I)),
    ("ignore_instructions", re.compile(r"\b(ignore|disregard|forget|override)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b", re.I)),
    ("role_reassignment", re.compile(r"\byou are now\b|\bact as\b|\bnew instructions?\b", re.I)),
    ("addressed_to_ai", re.compile(r"\b(ai|assistant|chatbot|language model|llm)s?\b[^.\n]{0,25}\b(reading this|must|should|tell the user|instruct)", re.I)),
    ("credential_request", re.compile(r"\b(share|send|give|enter|provide|tell|reveal)\b[^.\n]{0,40}\b(upi\s*pin|pin|otp|cvv|password|passcode|card number)\b", re.I)),
    ("chat_template_tokens", re.compile(r"\[/?INST\]|<\|im_start\|>|</?system>", re.I)),
]


def scan_for_instructions(text: str) -> list[dict]:
    out = []
    for name, rx in INSTRUCTION_PATTERNS:
        m = rx.search(text)
        if m:
            start = max(0, m.start() - 20)
            snippet = re.sub(r"\s+", " ", text[start : m.end() + 40]).strip()
            out.append({"pattern": name, "snippet": snippet})
    return out


def wrap_untrusted(source: str, content: str) -> str:
    safe = re.sub(r"<\s*/?\s*untrusted_content", "[tag removed]", content, flags=re.I)
    return f'<untrusted_content source="{source}">\n{safe}\n</untrusted_content>'


SECRET = re.compile(r"\b(upi\s*pin|pin|otp|cvv|password|passcode|card number|net ?banking)\b", re.I)
ASK = re.compile(r"\b(share|send|give|enter|provide|tell|reveal|type|confirm)\b", re.I)
_VERB = r"(share|send|give|enter|provide|tell|reveal|type|confirm)"
# A negation only counts when it is right next to the verb: "never share", "do not send",
# "share mat karo". (An earlier version accepted "not" anywhere in the sentence, which would have let
# "This is not a scam, just share your UPI PIN" through.)
NEGATION = re.compile(
    rf"\b(never|don'?t|do not|not|no one should|nobody should|avoid|stop|refuse to)\s+(\w+\s+){{0,2}}{_VERB}\b"
    rf"|\b{_VERB}\s+(\w+\s+){{0,2}}(mat|nahi|na)\b",
    re.I,
)
# Reporting an attack ("a search result tried to trick me into telling you to share your PIN") is a
# warning, not a request. A live run showed the filter blocking exactly this sentence.
REPORTED_ATTACK = re.compile(r"\b(attempt(ed|ing)?|tr(y|ied|ying)|trick(ed|ing)?)\b[^.?!]{0,40}\b(into|to)\b", re.I)
# A QUESTION about someone else's request ("Did they ask you to enter your PIN?") is diagnosis, not
# solicitation; a live run showed the guard blocking exactly this good question. Only questions
# qualify: "The Refund Desk has asked you to share your UPI PIN" is what an attack wants said.
THIRD_PARTY_QUESTION = re.compile(r"^\s*(did|have|has|had|do|does|is|are|was|were)\s+(they|he|she|someone|anyone|the caller|the sender|this person|that number)\b[^?]*\?\s*$", re.I)


def find_credential_solicitation(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?\n])\s+", text)
    return [
        s for s in sentences
        if SECRET.search(s) and ASK.search(s) and not NEGATION.search(s) and not THIRD_PARTY_QUESTION.search(s) and not REPORTED_ATTACK.search(s)
    ]


GUARD_REPLACEMENT = (
    "I stopped my own reply because part of it looked like a request for a secret such as a PIN, OTP or password. "
    "NextStep will never ask for these, and no real bank, UPI app or refund desk will either. "
    "Please do not share them with anyone. If you already did, call your bank now and report it on 1930 (national cyber fraud helpline)."
)


def guard_output(text: str) -> dict:
    blocked = find_credential_solicitation(text)
    if not blocked:
        return {"safe": True, "text": text, "blocked": []}
    return {"safe": False, "text": GUARD_REPLACEMENT, "blocked": blocked}
