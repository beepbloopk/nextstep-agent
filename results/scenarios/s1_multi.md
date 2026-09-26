# s1_multi: Multi-problem

Input (from https://nextstepmockapi.onrender.com/v1/scenarios):

> Viva is at 10am tomorrow, laptop won't boot, my project partner has been ignoring my calls for 2 days, and my dad just got admitted to a hospital in Surat. I'm in Pune.

## Turn 1

- status: `completed`, mode: `normal`, tool calls: 3/10, model: gemini-3.8-flash
- top priority (code-ranked): **Dad hospitalised in Surat** (model's own pick agrees)
- understood: Dad hospitalised in Surat [health_family/critical]; Viva tomorrow with non-booting laptop and missing partner [academic/high]
- missing info: Dad's condition severity/stability; Whether the user needs to travel to Surat immediately; Professor/evaluator contact info; Whether project files are backed up on cloud/drive
- actions taken: Saved a draft to Professor / Evaluator (not sent). Created 3 task(s): Call family in Surat to check dad's condition and travel need; Send emergency email to professor requesting viva rescheduling; Check phone for cloud backup of project files. You can undo any of them.

**Agent reply:**

> Your dad's health comes first. A medical emergency is a valid, standard ground for an academic deferral, so do not let panic about the viva stop you from focusing on your family right now.
> 
> Here are your next 3 steps:
> 
> 1. **Check on your dad immediately**: Call family or the hospital in Surat to understand how critical the situation is and whether you must leave Pune tonight.
> 2. **Email your professor tonight**: I have prepared a draft email requesting an emergency deferral citing your father's sudden hospitalisation, laptop failure, and unreachable partner. Review and send it now from your phone so an official request is logged well before 10:00 AM tomorrow.
> 3. **Check your phone for cloud backups**: Do a quick search on Google Drive, WhatsApp chats, or email on your phone to see if you have your report or slides saved, in case you need to submit whatever you have.
> 
> Take a deep breath and call your family first. If you need travel options to Surat or help reaching out to your partner, let me know.

**Draft saved (draft_0b86e4f8), not sent, shown to the user:**

```text
To: Professor / Evaluator (email)
Subject: Urgent: Emergency Viva Rescheduling Request - [Your Name] - [Roll Number]

Dear Professor [Professor's Name],

I am writing to urgently request an emergency rescheduling or permission to appear online for my viva scheduled for tomorrow, Sunday, at 10:00 AM. 

My father was just admitted to a hospital in Surat this evening, and I am currently coordinating his emergency care and may need to travel immediately from Pune. Additionally, my laptop has suffered a hardware boot failure, and I have been unable to reach my project partner for the past two days.

I will share whatever project documents or drafts are accessible via my cloud drive right away. Could you please grant me a deferral or advise on how I can appear under these extenuating circumstances? I will keep you updated as soon as my family situation stabilises.

Thank you very much for your understanding.

Sincerely,
[Your Name]
[Roll Number / Department]
[Phone Number]
```

<details><summary>Trace (labelled steps)</summary>

```text
1. [reasoning] assessment: 2 problem(s); request_type=situation_help; risk=none.
2. [reasoning] priority_ranked: Top priority (code-ranked): Dad hospitalised in Surat. Model's own pick agrees.
3. [executed] calculateTime: "tomorrow 10am" = Sun, 27 Sept, 2026, 10:00 am (12 hours 42 minutes left)
4. [executed] draft_saved: Draft draft_0b86e4f8 to Professor / Evaluator saved. Nothing sent.
5. [executed] createTask: Batch batch_a0aa44e0: created 3 task(s).
6. [reasoning] recommendation: Your dad's health comes first. A medical emergency is a valid, standard ground for an academic deferral, so do not let panic about the viva stop you from focusi
```

</details>
