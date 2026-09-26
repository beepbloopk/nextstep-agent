import { calculateTime } from "./tools/calculateTime.ts";

// The model extracts problems; CODE ranks them. Same extraction in, same ranking out, and the
// score breakdown explains "why this first" without trusting the model's own pick.
// (Blocker 8: this is one of the two determinism levers; the other is temperature 0.)

export interface Problem {
  id: string;
  title: string;
  category: string;
  urgency: "critical" | "high" | "medium" | "low";
  deadline_text: string | null;
  facts: string[];
}

export interface Assessment {
  language: string;
  request_type: "situation_help" | "out_of_scope" | "harmful";
  risk_level: "none" | "elevated" | "acute";
  risk_signals: string[];
  problems: Problem[];
  contradictions: { about: string; statements: string[]; provisional_choice: string }[];
  missing_info: string[];
  untrusted_instructions_seen: string[];
  top_priority: { problem_id: string; next_action: string; why: string };
}

const URGENCY: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };
// Safety of people first, then fraud risk, then things with hard external deadlines.
const CATEGORY: Record<string, number> = {
  health_family: 40,
  safety_fraud: 35,
  academic: 15,
  work: 15,
  housing: 15,
  money: 12,
  tech: 10,
  relationship: 8,
  other: 5,
};

export interface Ranked {
  id: string;
  title: string;
  score: number;
  reasons: string[];
}

export interface PriorityResult {
  ranked: Ranked[];
  top: Ranked[]; // more than one entry means a genuine tie, reported as a tie
  tie: boolean;
  modelPick: string;
  agreesWithModel: boolean;
}

export function rankProblems(a: Assessment, now: Date, tz: string): PriorityResult {
  const ranked = a.problems
    .map((p) => {
      const reasons: string[] = [];
      let score = 0;
      const u = URGENCY[p.urgency] ?? 10;
      score += u;
      reasons.push(`urgency ${p.urgency} (+${u})`);
      const c = CATEGORY[p.category] ?? 5;
      score += c;
      reasons.push(`category ${p.category} (+${c})`);
      if (p.deadline_text) {
        const t = calculateTime({ expression: p.deadline_text }, now, tz);
        if (t.minutesRemaining !== null && !t.alreadyPassed) {
          if (t.minutesRemaining <= 24 * 60) {
            score += 20;
            reasons.push(`deadline within 24h: ${t.resolved?.local} (+20)`);
          } else if (t.minutesRemaining <= 72 * 60) {
            score += 10;
            reasons.push(`deadline within 72h: ${t.resolved?.local} (+10)`);
          }
        }
      }
      return { id: p.id, title: p.title, score, reasons };
    })
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  const best = ranked[0]?.score ?? 0;
  const top = ranked.filter((r) => r.score === best);
  return {
    ranked,
    top,
    tie: top.length > 1,
    modelPick: a.top_priority?.problem_id ?? "",
    agreesWithModel: top.some((t) => t.id === a.top_priority?.problem_id),
  };
}
