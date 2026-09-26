// calculateTime(): turns "tomorrow", "by Friday", "5 tareekh", "10am kal" into a concrete
// deadline in the USER's timezone, computed from the real current time (via Clock).
//
// Two rules drive every edge case:
//  1. Dates are computed in the user's timezone, never the server's. At 00:30 IST the UTC date
//     is still "yesterday", so UTC-based "tomorrow" would silently lose a day.
//  2. When an expression is genuinely ambiguous we resolve to the EARLIER candidate and flag it
//     for confirmation. Being wrong on the early side costs the user some slack; being wrong on
//     the late side makes them miss the deadline.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

export function zonedParts(d: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    weekday: WEEKDAY_SHORT[p.weekday.toLowerCase()],
  };
}

function offsetMs(d: Date, tz: string): number {
  const z = zonedParts(d, tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
  return asUtc - Math.floor(d.getTime() / 60_000) * 60_000;
}

/** Wall-clock time in `tz` -> absolute Date. Re-checks the offset once to survive DST edges. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

interface CalDate {
  y: number;
  m: number;
  d: number;
}

function addDays(c: CalDate, n: number): CalDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function fmtLocal(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function humanDuration(ms: number): string {
  const neg = ms < 0;
  let mins = Math.round(Math.abs(ms) / 60_000);
  const days = Math.floor(mins / 1440);
  mins -= days * 1440;
  const hours = Math.floor(mins / 60);
  mins -= hours * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins || parts.length === 0) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  return (neg ? "-" : "") + parts.join(" ");
}

/** Pulls "10am", "10:30 pm", "22:00", "10 baje" out of the expression. */
function extractTime(expr: string): { h: number; m: number } | null {
  let mt = expr.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (mt) {
    let h = +mt[1] % 12;
    if (mt[3] === "pm") h += 12;
    return { h, m: mt[2] ? +mt[2] : 0 };
  }
  mt = expr.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (mt) return { h: +mt[1], m: +mt[2] };
  mt = expr.match(/\b(\d{1,2})\s*baje\b/);
  if (mt) return { h: +mt[1], m: 0 }; // "10 baje": am/pm not stated -> flagged below
  if (/\bnoon\b/.test(expr)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(expr)) return { h: 23, m: 59 };
  return null;
}

export interface Resolution {
  iso: string;
  local: string;
  date: string; // YYYY-MM-DD in user's timezone
  interpretation: string;
}

export interface CalculateTimeResult {
  expression: string;
  timezone: string;
  now: { iso: string; local: string };
  resolved: Resolution | null;
  timeSpecified: boolean;
  remaining: string | null;
  minutesRemaining: number | null;
  alreadyPassed: boolean;
  ambiguous: boolean;
  alternatives: Resolution[];
  assumptions: string[];
  needsUserConfirmation: boolean;
  error?: string;
}

export function calculateTime(input: { expression: string; timezone?: string }, now: Date, defaultTz: string): CalculateTimeResult {
  const tz = input.timezone || defaultTz;
  const expr = input.expression.toLowerCase().replace(/[.,!?…]/g, " ").replace(/\s+/g, " ").trim();
  const z = zonedParts(now, tz);
  const today: CalDate = { y: z.year, m: z.month, d: z.day };
  const assumptions: string[] = [];
  const candidates: { date: CalDate; interpretation: string }[] = [];
  let ambiguous = false;
  let relativeInstant: Date | null = null;

  const inMatch = expr.match(/\bin (\d+) (minute|min|hour|hr|day)s?\b/);
  const domMatch = expr.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(tareekh|tarikh|tarik|taarikh)\b/) || expr.match(/\b(?:the )?(\d{1,2})(st|nd|rd|th)\b/);
  const isoMatch = expr.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b|\\b${w.slice(0, 3)}\\b`).test(expr));

  if (inMatch) {
    const n = +inMatch[1];
    const unit = inMatch[2];
    const ms = unit.startsWith("min") ? n * 60_000 : unit.startsWith("h") ? n * 3_600_000 : n * 86_400_000;
    relativeInstant = new Date(now.getTime() + ms);
  } else if (isoMatch) {
    candidates.push({ date: { y: +isoMatch[1], m: +isoMatch[2], d: +isoMatch[3] }, interpretation: "explicit date" });
  } else if (/\bday after tomorrow\b|\bparso\b|\bparson\b/.test(expr)) {
    candidates.push({ date: addDays(today, 2), interpretation: "the day after tomorrow" });
    if (/\bparso|parson\b/.test(expr)) assumptions.push('"parso" can mean two days ago or two days ahead; assumed ahead because this is a deadline.');
  } else if (/\btomorrow\b|\bkal\b/.test(expr)) {
    if (/\bkal\b/.test(expr)) assumptions.push('"kal" can mean yesterday or tomorrow; assumed tomorrow because this is a deadline.');
    if (z.hour < 4) {
      // 00:00-03:59: someone who has not slept yet often means "after I sleep", i.e. today's date.
      ambiguous = true;
      candidates.push({ date: today, interpretation: `later today (it is past midnight, so "tomorrow" may mean the day that has already started)` });
      candidates.push({ date: addDays(today, 1), interpretation: "the next calendar day" });
    } else {
      candidates.push({ date: addDays(today, 1), interpretation: "the next calendar day" });
      if (z.hour >= 22) {
        const minsToMidnight = (24 - z.hour) * 60 - z.minute;
        assumptions.push(`It is late (${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}); "tomorrow" starts in ${minsToMidnight} minutes. Any morning deadline tomorrow is hours away, not a full day.`);
      }
    }
  } else if (/\btonight\b|\baaj raat\b/.test(expr)) {
    candidates.push({ date: today, interpretation: "tonight" });
  } else if (/\btoday\b|\baaj\b|\beod\b/.test(expr)) {
    candidates.push({ date: today, interpretation: "today" });
  } else if (wd >= 0) {
    const name = WEEKDAYS[wd][0].toUpperCase() + WEEKDAYS[wd].slice(1);
    const delta = (wd - z.weekday + 7) % 7;
    const isNext = /\bnext\b/.test(expr);
    const isThis = /\bthis\b/.test(expr);
    if (delta === 0 && !isNext && !isThis) {
      // "by Friday" said ON a Friday: today, or a week from today?
      ambiguous = true;
      candidates.push({ date: today, interpretation: `today (it is ${name} today)` });
      candidates.push({ date: addDays(today, 7), interpretation: `${name} next week` });
    } else if (delta === 0 && isThis) {
      candidates.push({ date: today, interpretation: `today (${name})` });
    } else if (isNext) {
      // "next Friday" on a Wednesday: the one in 2 days, or the one after?
      const first = delta === 0 ? 7 : delta;
      if (delta !== 0) {
        ambiguous = true;
        candidates.push({ date: addDays(today, first), interpretation: `the coming ${name}` });
        candidates.push({ date: addDays(today, first + 7), interpretation: `${name} of next week` });
      } else {
        candidates.push({ date: addDays(today, 7), interpretation: `${name} next week` });
      }
    } else {
      candidates.push({ date: addDays(today, delta), interpretation: `the coming ${name}` });
    }
  } else if (domMatch) {
    const dom = +domMatch[1];
    let c: CalDate = { y: today.y, m: today.m, d: dom };
    if (dom < today.d) {
      c = today.m === 12 ? { y: today.y + 1, m: 1, d: dom } : { y: today.y, m: today.m + 1, d: dom };
      assumptions.push(`The ${dom}th has already passed this month, so assumed the ${dom}th of next month.`);
    }
    candidates.push({ date: c, interpretation: `the ${dom}th` });
  }

  const time = extractTime(expr);
  const timeSpecified = time !== null || relativeInstant !== null;
  if (/\bbaje\b/.test(expr) && time && time.h <= 12) assumptions.push(`"${time.h} baje" does not say am or pm; assumed ${time.h}:00 as written (24h), please confirm.`);

  const base: CalculateTimeResult = {
    expression: input.expression,
    timezone: tz,
    now: { iso: now.toISOString(), local: fmtLocal(now, tz) },
    resolved: null,
    timeSpecified,
    remaining: null,
    minutesRemaining: null,
    alreadyPassed: false,
    ambiguous,
    alternatives: [],
    assumptions,
    needsUserConfirmation: ambiguous,
  };

  const toResolution = (date: CalDate, interpretation: string): Resolution => {
    const h = time ? time.h : 23;
    const m = time ? time.m : 59;
    const inst = zonedToUtc(date.y, date.m, date.d, h, m, tz);
    const ymd = `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
    return { iso: inst.toISOString(), local: fmtLocal(inst, tz), date: ymd, interpretation };
  };

  if (relativeInstant) {
    const zr = zonedParts(relativeInstant, tz);
    base.resolved = {
      iso: relativeInstant.toISOString(),
      local: fmtLocal(relativeInstant, tz),
      date: `${zr.year}-${String(zr.month).padStart(2, "0")}-${String(zr.day).padStart(2, "0")}`,
      interpretation: `relative to now`,
    };
  } else if (candidates.length > 0) {
    // candidates are pushed earliest-first; the earliest is the primary answer.
    base.resolved = toResolution(candidates[0].date, candidates[0].interpretation);
    base.alternatives = candidates.slice(1).map((c) => toResolution(c.date, c.interpretation));
    if (!time) assumptions.push("No time was given, so the deadline is set to 11:59pm that day. Ask for the exact time if it matters.");
  } else if (time) {
    // Only a time ("by 6pm"): today if still ahead, otherwise tomorrow.
    const todayRes = toResolution(today, "today");
    if (new Date(todayRes.iso).getTime() > now.getTime()) base.resolved = todayRes;
    else {
      base.resolved = toResolution(addDays(today, 1), "tomorrow (that time has already passed today)");
      assumptions.push("That time has already passed today, so assumed tomorrow.");
      base.needsUserConfirmation = true;
    }
  } else {
    return { ...base, error: `Could not understand "${input.expression}" as a date or time. Ask the user for the exact date.`, needsUserConfirmation: true };
  }

  const diff = new Date(base.resolved!.iso).getTime() - now.getTime();
  base.minutesRemaining = Math.round(diff / 60_000);
  base.remaining = humanDuration(diff);
  base.alreadyPassed = diff < 0;
  if (base.alreadyPassed) {
    assumptions.push("This time has already passed.");
    base.needsUserConfirmation = true;
  }
  return base;
}
