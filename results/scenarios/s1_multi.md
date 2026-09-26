# s1_multi: Multi-problem

Input (from https://nextstepmockapi.onrender.com/v1/scenarios (attempt 1)):

> Viva is at 10am tomorrow, laptop won't boot, my project partner has been ignoring my calls for 2 days, and my dad just got admitted to a hospital in Surat. I'm in Pune.

## Turn 1

- status: `completed`, mode: `normal`, tool calls: 2/10, model: gemini-3.5-flash + gemini-3.1-flash-lite-preview
- top priority (code-ranked): **Dad hospitalized in Surat** (AI's own pick agrees)
- understood: Dad hospitalized in Surat [health_family/critical]; Academic Viva tomorrow with technical and partner issues [academic/high]
- missing info: Dad's health status / severity of hospitalisation; Whether user needs to travel to Surat immediately; Project partner's name or contact details; Professor's name or contact details for the Viva
- actions taken: Saved a draft to Professor / Viva Examiner (not sent).

**Agent reply:**

> I am so sorry to hear about your father. Please prioritize your family right now; everything else can be sorted out later.
> 
> I have drafted an email for your professor to request a reschedule. You can review and send this whenever you are ready.
> 
> **Questions to help you plan:**
> 1. Do you need to leave for Surat immediately?
> 2. Do you have family or friends in Surat who can help with your dad, or are you the primary person who needs to be there?
> 3. Is there anything else urgent you need to handle before you leave?
> 
> **Next Steps:**
> *   **Review the draft:** I have saved a draft email for your professor (ID: `draft_643302e7`). You can ask me to show it to you, or you can edit it yourself.
> *   **Focus on travel:** If you need to go to Surat, please focus on your travel arrangements first. Do not worry about the laptop or your project partner right now.
> *   **Communicate:** Once you are on your way or have a moment, send that email to your professor. They will likely be understanding given the circumstances.
> 
> Please let me know if you need help with anything else.

**Draft saved (draft_643302e7), not sent, shown to the user:**

```text
To: Professor / Viva Examiner (email)
Subject: Urgent: Request to reschedule Viva due to family medical emergency - [Your Name]

Dear Professor,

I am writing to urgently request a reschedule or an online option for my Viva scheduled for tomorrow, Sunday at 10:00 AM. 

My father has just been admitted to a hospital in Surat due to a medical emergency, and I need to attend to this family crisis immediately. Additionally, my laptop has experienced a technical failure and is not booting. 

I would be extremely grateful if I could be permitted to take the Viva at a later date or online once the situation stabilizes. I will keep you updated and can provide medical documentation if required.

Thank you for your understanding.

Sincerely,
[Your Name]
```

<details><summary>Trace (labelled steps)</summary>

```text
1. [reasoning] assessment: 2 problem(s); request_type=situation_help; risk=none.
2. [reasoning] priority_ranked: Top priority (code-ranked): Dad hospitalized in Surat. Model's own pick agrees.
3. [executed] calculateTime: "tomorrow 10am" = Sun, 27 Sep 2026, 10:00 AM (11 hours 51 minutes left)
4. [executed] draft_saved: Draft draft_643302e7 to Professor / Viva Examiner saved. Nothing sent.
5. [reasoning] recommendation: I am so sorry to hear about your father. Please prioritize your family right now; everything else can be sorted out later.
```

</details>
