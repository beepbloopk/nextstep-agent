# Determinism check (blocker 8)

Model `gemini-3.1-flash-lite`, temperature 0, 5 fresh runs of the same input, run at 2026-09-26T15:57:55.796Z.

> Viva is at 10am tomorrow, laptop won't boot, my project partner has been ignoring my calls for 2 days, and my dad just got admitted to a hospital in Surat. I'm in Pune.

| run | model | top priority (code-ranked) | category | model's own pick | category | model's proposed next action |
|---|---|---|---|---|---|---|
| 1 | gemini-3.1-flash-lite+gemini-3.1-flash-lite | Dad's hospitalization | health_family | Dad's hospitalization | health_family | Prioritize the family emergency and communicate with the college immediately. |
| 2 | gemini-3.1-flash-lite+gemini-3.1-flash-lite | Dad's hospitalization | health_family | Dad's hospitalization | health_family | Address the family emergency first, then communicate with the college regarding the viva. |
| 3 | gemini-3.1-flash-lite+gemini-3.1-flash-lite | Dad's health emergency | health_family | Dad's health emergency | health_family | Assess if the user needs to travel to Surat immediately or if they can manage the viva first. |
| 4 | gemini-3.1-flash-lite+gemini-3.1-flash-lite | Dad's hospitalization | health_family | Dad's hospitalization | health_family | Contact professor/college regarding the viva and prioritize family situation. |
| 5 | gemini-3.1-flash-lite+gemini-3.1-flash-lite | Family Emergency | health_family | Family Emergency | health_family | Prioritize the family emergency and communicate the situation to the professor immediately. |

- Code-ranked top category stable across runs: **true**
- Model's own pick stable across runs: **true**
- Proposed next action identical word for word: **false** (free text, so wording differences are expected; compare meaning)

Titles and actions are free text written by the model, so stability is judged by category. Runs are assess-only (Understand + Reason) to fit the free-tier quota.
