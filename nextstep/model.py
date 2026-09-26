"""The AI connection.

The agent loop speaks one simple message format: a list of {"role", "content"} where content is a
string or a list of blocks: {"type": "text"}, {"type": "tool_use", "id", "name", "input"},
{"type": "tool_result", "tool_use_id", "content"}. A model reply is a dict:
{"model", "content": [blocks], "stop_reason": "tool_use" | "end_turn" | "max_tokens"}.

Two models implement `create(request) -> reply`:
- ScriptedModel: replays a fixed script. Used by the tests, so they need no key and no randomness.
- GeminiModel: Google Gemini over plain HTTP (urllib), with a fallback chain for free-tier quotas.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid

_seq = 0


def _next_id(prefix: str) -> str:
    global _seq
    _seq += 1
    return f"{prefix}_{_seq}"


def fake_reply(blocks: list[dict]) -> dict:
    content = [({**b, "id": b.get("id") or _next_id("toolu_fake")} if b["type"] == "tool_use" else b) for b in blocks]
    return {"model": "scripted", "content": content, "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"}


def tool(name: str, input: dict) -> dict:
    return fake_reply([{"type": "tool_use", "name": name, "input": input}])


def text(t: str) -> dict:
    return fake_reply([{"type": "text", "text": t}])


class ScriptedModel:
    """Replays a fixed list of replies. A step can also be a function(request) -> reply."""

    name = "scripted"

    def __init__(self, turns: list):
        self.turns = list(turns)
        self.calls: list[dict] = []

    def create(self, request: dict) -> dict:
        self.calls.append(request)
        if not self.turns:
            return text("(script ended)")
        nxt = self.turns.pop(0)
        return nxt(request) if callable(nxt) else nxt


# ---------------------------------------------------------------------------------------------
# Gemini

_SCHEMA_KEYS = {"type", "description", "enum", "properties", "required", "items", "nullable", "format", "minItems", "maxItems"}


def to_gemini_schema(schema) -> dict:
    """JSON Schema -> the OpenAPI subset Gemini accepts (upper-case types, nullable instead of null)."""
    if not isinstance(schema, dict):
        return {}
    out = {}
    for k, v in schema.items():
        if k not in _SCHEMA_KEYS:
            continue
        if k == "type" and isinstance(v, list):
            non_null = [t for t in v if t != "null"]
            out["type"] = (non_null[0] if non_null else "string").upper()
            if "null" in v:
                out["nullable"] = True
        elif k == "type":
            out["type"] = str(v).upper()
        elif k == "properties":
            out["properties"] = {pk: to_gemini_schema(pv) for pk, pv in v.items()}
        elif k == "items":
            out["items"] = to_gemini_schema(v)
        else:
            out[k] = v
    return out


def to_gemini_request(req: dict, thinking: dict | None, target_model: str = "") -> dict:
    id_to_name: dict[str, str] = {}
    contents = []
    for m in req["messages"]:
        role = "model" if m["role"] == "assistant" else "user"
        parts = []
        if isinstance(m["content"], str):
            parts.append({"text": m["content"]})
        else:
            for b in m["content"]:
                # A thought signature is only valid on the model that produced it. After a fallback,
                # text drops it and function calls carry Google's documented placeholder.
                own = b.get("gemini_signature") and b.get("gemini_model") == target_model
                sig = {"thoughtSignature": b["gemini_signature"]} if own else {}
                if b["type"] == "text":
                    if b.get("text"):
                        parts.append({"text": b["text"], **sig})
                elif b["type"] == "tool_use":
                    id_to_name[b["id"]] = b["name"]
                    call = {"name": b["name"], "args": b.get("input") or {}}
                    if b.get("gemini_call_id"):
                        call["id"] = b["gemini_call_id"]
                    parts.append({"functionCall": call, **(sig if own else {"thoughtSignature": "skip_thought_signature_validator"})})
                elif b["type"] == "tool_result":
                    resp = {"name": id_to_name.get(b["tool_use_id"], "unknown_tool"), "response": {"content": b["content"], **({"is_error": True} if b.get("is_error") else {})}}
                    if not b["tool_use_id"].startswith("toolu_gem_"):
                        resp["id"] = b["tool_use_id"]
                    parts.append({"functionResponse": resp})
        if parts:
            contents.append({"role": role, "parts": parts})

    gen = {"maxOutputTokens": req.get("max_tokens", 2048)}
    if "temperature" in req:
        gen["temperature"] = req["temperature"]
    if thinking:
        gen["thinkingConfig"] = thinking
    body = {"contents": contents, "generationConfig": gen}
    if req.get("system"):
        body["systemInstruction"] = {"parts": [{"text": req["system"]}]}
    if req.get("tools"):
        body["tools"] = [{"functionDeclarations": [{"name": t["name"], "description": t.get("description", ""), "parameters": to_gemini_schema(t["input_schema"])} for t in req["tools"]]}]
        tc = req.get("tool_choice") or {}
        if tc.get("type") == "tool":
            cfg = {"mode": "ANY", "allowedFunctionNames": [tc["name"]]}
        else:
            cfg = {"mode": "AUTO"}
        body["toolConfig"] = {"functionCallingConfig": cfg}
    return body


def from_gemini_response(r: dict, model: str) -> dict:
    cand = (r.get("candidates") or [{}])[0]
    content = []
    for part in (cand.get("content") or {}).get("parts") or []:
        if part.get("thought"):
            continue  # thinking summaries are not part of the answer
        sig = {"gemini_signature": part["thoughtSignature"], "gemini_model": model} if part.get("thoughtSignature") else {}
        if part.get("functionCall"):
            fc = part["functionCall"]
            block = {"type": "tool_use", "id": fc.get("id") or f"toolu_gem_{uuid.uuid4().hex[:10]}", "name": fc["name"], "input": fc.get("args") or {}, **sig}
            if fc.get("id"):
                block["gemini_call_id"] = fc["id"]
            content.append(block)
        elif part.get("text"):
            content.append({"type": "text", "text": part["text"], **sig})
    has_tool = any(b["type"] == "tool_use" for b in content)
    finish = cand.get("finishReason", "STOP")
    return {"model": model, "content": content, "stop_reason": "tool_use" if has_tool else "max_tokens" if finish == "MAX_TOKENS" else "end_turn"}


class GeminiError(Exception):
    pass


class GeminiModel:
    """Accepts one model or a comma-separated fallback chain. Per-minute limits and server errors are
    retried on the same model. A daily quota, a retired model (404) or a model that stays overloaded
    moves the call to the next model. The reply's `model` field says which one answered."""

    def __init__(self, model: str, api_key: str, post=None, sleep=time.sleep):
        self.chain = [m.strip() for m in model.split(",") if m.strip()]
        self.name = ",".join(self.chain)
        self.api_key = api_key
        self.exhausted: set[str] = set()
        self._post = post or self._http_post
        self._sleep = sleep

    def _http_post(self, url: str, body: dict) -> tuple[int, str]:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", "x-goog-api-key": self.api_key}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return resp.status, resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def create(self, request: dict) -> dict:
        errors = []
        for model in self.chain:
            if model in self.exhausted:
                continue
            ok, result, skip_forever = self._try(model, request)
            if ok:
                return result
            errors.append(f"{model}: {result}")
            if skip_forever:
                self.exhausted.add(model)
        raise GeminiError("Gemini request failed on every model in the chain. " + " || ".join(errors))

    def _try(self, model: str, request: dict):
        # Keep thinking low: faster, lighter on the free quota, more repeatable.
        thinking = {"thinkingLevel": os.environ.get("GEMINI_THINKING_LEVEL", "low")} if "gemini-3" in model else None
        body = to_gemini_request(request, thinking, model)
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        last = ""
        for attempt in range(1, 5):
            try:
                status, text_ = self._post(url, body)
            except Exception as err:  # noqa: BLE001 - network errors are retried
                last = f"network: {err}"
                self._sleep(min(2**attempt, 20))
                continue
            if status == 200:
                return True, from_gemini_response(json.loads(text_), model), False
            last = f"HTTP {status}: {' '.join(text_.split())[:200]}"
            if status == 404:
                return False, last, True
            if status == 429 and re.search(r"PerDay", text_, re.I):
                return False, "daily free-tier quota used up", True
            if status == 429 or status >= 500:
                m = re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', text_)
                self._sleep(float(m.group(1)) + 0.5 if m else min(2 ** attempt * 2, 30))
                continue
            return False, last, False
        return False, last, False
