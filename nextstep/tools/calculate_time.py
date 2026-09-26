"""calculateTime(): turns "tomorrow", "by Friday", "5 tareekh", "10am kal" into a real deadline in
the USER's timezone, using the real current time.

Two rules drive every edge case:
 1. Dates are worked out in the user's timezone, never the server's. At 00:30 IST the UTC date is
    still "yesterday", so a UTC-based "tomorrow" would silently lose a day.
 2. When an expression is genuinely ambiguous we pick the EARLIER date and flag it. Being early
    costs the user some slack; being late makes them miss the deadline.
"""
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]  # Python: Monday = 0


def _fmt(dt: datetime) -> str:
    return dt.strftime("%a, %d %b %Y, %I:%M %p").replace(" 0", " ")


def _human(delta: timedelta) -> str:
    neg = delta.total_seconds() < 0
    mins = round(abs(delta.total_seconds()) / 60)
    days, mins = divmod(mins, 1440)
    hours, mins = divmod(mins, 60)
    parts = []
    if days:
        parts.append(f"{days} day{'s' if days != 1 else ''}")
    if hours:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    if mins or not parts:
        parts.append(f"{mins} minute{'s' if mins != 1 else ''}")
    return ("-" if neg else "") + " ".join(parts)


def _extract_time(expr: str) -> tuple[int, int] | None:
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", expr)
    if m:
        h = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0)
        return h, int(m.group(2) or 0)
    m = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", expr)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"\b(\d{1,2})\s*baje\b", expr)
    if m:
        return int(m.group(1)), 0
    if re.search(r"\bnoon\b", expr):
        return 12, 0
    if re.search(r"\bmidnight\b", expr):
        return 23, 59
    return None


def calculate_time(expression: str, now: datetime, tz_name: str) -> dict:
    tz = ZoneInfo(tz_name)
    local_now = now.astimezone(tz)
    today = local_now.date()
    expr = re.sub(r"\s+", " ", re.sub(r"[.,!?…]", " ", expression.lower())).strip()
    assumptions: list[str] = []
    candidates: list[tuple[date, str]] = []
    ambiguous = False
    relative: datetime | None = None

    in_m = re.search(r"\bin (\d+) (minute|min|hour|hr|day)s?\b", expr)
    dom_m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s*(tareekh|tarikh|tarik|taarikh)\b", expr) or re.search(r"\b(?:the )?(\d{1,2})(st|nd|rd|th)\b", expr)
    iso_m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", expr)
    wd = next((i for i, w in enumerate(WEEKDAYS) if re.search(rf"\b{w}\b|\b{w[:3]}\b", expr)), -1)

    if in_m:
        n, unit = int(in_m.group(1)), in_m.group(2)
        delta = timedelta(minutes=n) if unit.startswith("min") else timedelta(hours=n) if unit.startswith("h") else timedelta(days=n)
        relative = now + delta
    elif iso_m:
        candidates.append((date(int(iso_m.group(1)), int(iso_m.group(2)), int(iso_m.group(3))), "explicit date"))
    elif re.search(r"\bday after tomorrow\b|\bparso\b|\bparson\b", expr):
        candidates.append((today + timedelta(days=2), "the day after tomorrow"))
        if re.search(r"\bparso|parson\b", expr):
            assumptions.append('"parso" can mean two days ago or two days ahead; assumed ahead because this is a deadline.')
    elif re.search(r"\btomorrow\b|\bkal\b", expr):
        if re.search(r"\bkal\b", expr):
            assumptions.append('"kal" can mean yesterday or tomorrow; assumed tomorrow because this is a deadline.')
        if local_now.hour < 4:
            # 00:00-03:59: someone who has not slept yet often means "after I sleep", i.e. today's date.
            ambiguous = True
            candidates.append((today, 'later today (it is past midnight, so "tomorrow" may mean the day that has already started)'))
            candidates.append((today + timedelta(days=1), "the next calendar day"))
        else:
            candidates.append((today + timedelta(days=1), "the next calendar day"))
            if local_now.hour >= 22:
                mins_left = (24 - local_now.hour) * 60 - local_now.minute
                assumptions.append(f'It is late ({local_now:%H:%M}); "tomorrow" starts in {mins_left} minutes. Any morning deadline tomorrow is hours away, not a full day.')
    elif re.search(r"\btonight\b|\baaj raat\b", expr):
        candidates.append((today, "tonight"))
    elif re.search(r"\btoday\b|\baaj\b|\beod\b", expr):
        candidates.append((today, "today"))
    elif wd >= 0:
        name = WEEKDAYS[wd].capitalize()
        delta = (wd - today.weekday()) % 7
        is_next = bool(re.search(r"\bnext\b", expr))
        is_this = bool(re.search(r"\bthis\b", expr))
        if delta == 0 and not is_next and not is_this:
            # "by Friday" said ON a Friday: today, or a week from today?
            ambiguous = True
            candidates.append((today, f"today (it is {name} today)"))
            candidates.append((today + timedelta(days=7), f"{name} next week"))
        elif delta == 0 and is_this:
            candidates.append((today, f"today ({name})"))
        elif is_next and delta != 0:
            ambiguous = True
            candidates.append((today + timedelta(days=delta), f"the coming {name}"))
            candidates.append((today + timedelta(days=delta + 7), f"{name} of next week"))
        elif is_next:
            candidates.append((today + timedelta(days=7), f"{name} next week"))
        else:
            candidates.append((today + timedelta(days=delta), f"the coming {name}"))
    elif dom_m:
        dom = int(dom_m.group(1))
        target = date(today.year, today.month, dom) if dom >= today.day else None
        if target is None:
            y, m = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
            target = date(y, m, dom)
            assumptions.append(f"The {dom}th has already passed this month, so assumed the {dom}th of next month.")
        candidates.append((target, f"the {dom}th"))

    t = _extract_time(expr)
    time_specified = t is not None or relative is not None
    if re.search(r"\bbaje\b", expr) and t and t[0] <= 12:
        assumptions.append(f'"{t[0]} baje" does not say am or pm; assumed {t[0]}:00 as written, please confirm.')

    def resolve(d: date, interp: str) -> dict:
        h, m = t if t else (23, 59)
        dt = datetime.combine(d, time(h, m), tzinfo=tz)
        return {"iso": dt.isoformat(), "local": _fmt(dt), "date": d.isoformat(), "interpretation": interp}

    result = {
        "expression": expression,
        "timezone": tz_name,
        "now": {"iso": now.isoformat(), "local": _fmt(local_now)},
        "resolved": None,
        "timeSpecified": time_specified,
        "remaining": None,
        "minutesRemaining": None,
        "alreadyPassed": False,
        "ambiguous": ambiguous,
        "alternatives": [],
        "assumptions": assumptions,
        "needsUserConfirmation": ambiguous,
    }

    if relative:
        lr = relative.astimezone(tz)
        result["resolved"] = {"iso": lr.isoformat(), "local": _fmt(lr), "date": lr.date().isoformat(), "interpretation": "relative to now"}
    elif candidates:
        result["resolved"] = resolve(*candidates[0])  # earliest candidate first
        result["alternatives"] = [resolve(*c) for c in candidates[1:]]
        if not t:
            assumptions.append("No time was given, so the deadline is set to 11:59pm that day. Ask for the exact time if it matters.")
    elif t:
        today_res = resolve(today, "today")
        if datetime.fromisoformat(today_res["iso"]) > now:
            result["resolved"] = today_res
        else:
            result["resolved"] = resolve(today + timedelta(days=1), "tomorrow (that time has already passed today)")
            assumptions.append("That time has already passed today, so assumed tomorrow.")
            result["needsUserConfirmation"] = True
    else:
        result["error"] = f'Could not understand "{expression}" as a date or time. Ask the user for the exact date.'
        result["needsUserConfirmation"] = True
        return result

    diff = datetime.fromisoformat(result["resolved"]["iso"]) - now
    result["minutesRemaining"] = round(diff.total_seconds() / 60)
    result["remaining"] = _human(diff)
    result["alreadyPassed"] = diff.total_seconds() < 0
    if result["alreadyPassed"]:
        assumptions.append("This time has already passed.")
        result["needsUserConfirmation"] = True
    return result
