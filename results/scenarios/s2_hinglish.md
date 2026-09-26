# s2_hinglish: Hinglish

Input (from https://nextstepmockapi.onrender.com/v1/scenarios (attempt 1)):

> Kal submission hai, laptop dead ho gaya, aur landlord bol raha hai 5 tareekh tak flat khaali karo. Paise bhi nahi hai abhi.

## Turn 1

- status: `awaiting_user`, mode: `normal`, tool calls: 3/10, model: gemini-3.5-flash + gemini-3.1-flash-lite-preview
- top priority (code-ranked): **Academic submission tomorrow with dead laptop** (AI's own pick agrees)
- understood: Academic submission tomorrow with dead laptop [academic/critical]; Eviction notice by landlord with financial constraint [housing/high]
- missing info: What is the submission about?; Can the submission be done from a phone, a friend's laptop, or a cyber cafe?; Why is the landlord asking to vacate? Is there a lease agreement?

**Agent reply:**

> 1. Kya aapke paas kal subah laptop borrow karne ka ya cyber cafe jaane ka koi option hai?
> 2. Kya landlord ne rent na dene ki wajah se eviction notice diya hai, ya koi aur reason hai?
> 3. Kya aapke paas koi written lease agreement hai?

<details><summary>Trace (labelled steps)</summary>

```text
1. [reasoning] assessment: 2 problem(s); request_type=situation_help; risk=none.
2. [reasoning] priority_ranked: Top priority (code-ranked): Academic submission tomorrow with dead laptop. Model's own pick agrees.
3. [executed] calculateTime: "tomorrow" = Sun, 27 Sep 2026, 11:59 PM (1 day 1 hour 47 minutes left)
4. [executed] calculateTime: "5 tareekh" = Mon, 5 Oct 2026, 11:59 PM (9 days 1 hour 47 minutes left)
5. [asking] clarifying_questions: Kya aapke paas kal subah laptop borrow karne ka ya cyber cafe jaane ka koi option hai? | Kya landlord ne rent na dene ki wajah se eviction notice diya hai, ya k
```

</details>

## Turn 2

SIMULATED user answer (written for this test run, not a real user): "Submission college assignment ka hai, kal raat 11:59 tak. Landlord ne sirf phone pe bola, likhit mein kuch nahi. Mere paas abhi 2000 rupaye hain."

- status: `completed`, mode: `normal`, tool calls: 1/10, model: gemini-3.1-flash-lite-preview
- top priority (code-ranked): **College assignment submission** (AI's own pick agrees)
- understood: College assignment submission [academic/critical]; Eviction threat [housing/high]; Financial constraint [money/high]
- missing info: Does the user have access to a library or a friend who can lend a laptop?; Is the assignment something that can be done on a phone or tablet?
- actions taken: Created 3 task(s): Submit college assignment; Contact professor for extension if needed; Address housing situation. You can undo any of them.

**Agent reply:**

> Yeh situation kaafi stressful hai, par hum step-by-step handle karenge. Sabse pehle assignment par focus karte hain kyunki uska deadline kal raat hai. Landlord ka verbal notice legal nahi hota, isliye uske liye abhi panic mat karo, aapke paas 5 tareekh tak ka time hai.
> 
> **Top Priority:** Kal raat 11:59 PM tak assignment submit karna.
> 
> **Next Steps:**
> 1. **Assignment:** Kal subah hote hi kisi cyber cafe jao ya kisi dost se laptop borrow karo. Agar assignment simple hai, toh check karo kya wo phone par ho sakta hai. Agar bilkul nahi ho pa raha, toh professor ko abhi ek email draft kar do (main aapki help kar sakta hoon) taaki extension mil sake.
> 2. **Housing:** Landlord ne sirf verbal bola hai, iska matlab wo aapko kal hi nahi nikal sakta. 5 tareekh tak ka time hai, toh abhi apne 2000 rupaye kharch mat karo, unhe emergency ke liye bachao.
> 3. **Stay Calm:** Ek cheez at a time karo. Pehle assignment, phir housing ke baare mein kisi senior ya friend se baat karna.
> 
> Kya aap chahte ho ki main professor ko bhejne ke liye ek extension request ka draft likhoon?
> 
> That is a lot to carry at once. If it starts to feel like too much, you can talk to someone at Tele-MANAS on 14416 (free, 24x7).

<details><summary>Trace (labelled steps)</summary>

```text
1. [reasoning] assessment: 3 problem(s); request_type=situation_help; risk=elevated.
2. [reasoning] priority_ranked: Top priority (code-ranked): College assignment submission. Model's own pick agrees.
3. [reasoning] wellbeing_check_in: Model flagged elevated stress (User is facing multiple crises simultaneously (academic, housing, financial) which is overwhelming.) with no crisis language. Kee
4. [executed] createTask: Batch batch_5735878b: created 3 task(s).
5. [reasoning] recommendation: Yeh situation kaafi stressful hai, par hum step-by-step handle karenge. Sabse pehle assignment par focus karte hain kyunki uska deadline kal raat hai. Landlord 
```

</details>
