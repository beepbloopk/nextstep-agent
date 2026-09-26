# NextStep Agent (Role 06: AI Application Developer)

An agent that takes real actions for an overwhelmed user (works out deadlines, creates tasks, drafts messages) but never lets an irreversible action happen until the user has seen the exact text and confirmed it.

The core idea: **thinking about an action and performing it are different code paths.** The model can reason, call read-only tools, change NextStep's own reversible state, and *propose* a send. It cannot send. Sending lives in a separate lifecycle (propose, confirm, execute) that the model has no tool for, and every step of it is an entry in an append-only log.

- Node.js + TypeScript, runs directly on Node's built-in type stripping (no build step)
- One runtime dependency (`@anthropic-ai/sdk`, for the Claude provider and its types). The Gemini provider is plain `fetch`
- Model: Gemini (`gemini-3.8-flash`, free tier) by default, Claude (`claude-haiku-4-5`) supported. Model names come from env, never hardcoded in logic
- No agent framework: the loop is one file, [src/agent.ts](src/agent.ts)

**Where to look first:** [traces/sample-run-scenario7.md](traces/sample-run-scenario7.md) (one full labelled run), [results/scenarios/](results/scenarios/) (all 7 shared inputs), [results/blockers-demo.md](results/blockers-demo.md) (every failure path, reproducible offline).

---

## Setup

Requirements: Node.js 22.18 or newer (developed on Node 24.19).

```bash
npm install
```

Create a `.env` file in the project root (see [.env.example](.env.example)). For the free Gemini tier, get a key at aistudio.google.com ("Get API key"):

```
GEMINI_API_KEY=AIza...
```

Optional settings: `GEMINI_MODEL` (default `gemini-3.8-flash`), `GEMINI_THINKING_LEVEL` (default `low`), `ANTHROPIC_API_KEY` + `NEXTSTEP_PROVIDER=anthropic` to use Claude instead, `NEXTSTEP_CANDIDATE_ID` (sent as `X-Candidate-Id` to the mock API), `NEXTSTEP_TZ` (default `Asia/Kolkata`), `NEXTSTEP_MAX_TOOL_CALLS` (default 10).

| Command | Needs a key | What it does |
|---|---|---|
| `npm test` | no | 36 offline tests: every blocker, calculateTime edge cases, injection guards, erasure, the Gemini adapter |
| `npm run demo:blockers` | no | Narrated run of blockers 1 to 5 and 7 against the real harness with a scripted model. Writes [results/blockers-demo.md](results/blockers-demo.md) |
| `npm run typecheck` | no | Strict `tsc` check |
| `npm run agent` | yes | Interactive CLI. Describe a situation, answer questions, review and confirm sends. `update: ...` to reassess, `forget` to erase |
| `npm run scenarios` | yes | All 7 shared scenarios, saved to [results/scenarios/](results/scenarios/) |
| `npm run trace:sample` | yes | One full labelled run of scenario 7, saved to [traces/](traces/) |
| `npm run determinism` | yes | Same input 5 times, saved to [results/determinism.md](results/determinism.md) |
| `npm run injection` | yes | Live prompt-injection test (pasted and second-order), saved to [results/injection-live.md](results/injection-live.md) |

`NEXTSTEP_SHOW_TRACE=1 npm run agent` prints each labelled trace step as it happens.

---

## Architecture

```mermaid
flowchart TD
    U[User message + optional pasted text] --> S1

    subgraph Harness["Harness (deterministic code, src/agent.ts)"]
      S1["Understand 1: screens<br/>policy.screenRequest (harmful?)<br/>policy.screenRisk (at risk?)<br/>untrusted.scanForInstructions"]
      S1 -- harmful --> REF[Refuse with reason + honest alternative<br/>no model call, no draft tool]
      S1 -- at risk --> SUP[Support mode<br/>model called with NO tools<br/>helpline, one gentle question]
      S1 -- ok --> S2["Understand 2: forced recordAssessment<br/>(structured: problems, contradictions,<br/>missing info, risk, request type)"]
      S2 --> RANK["Reason: priority.rankProblems<br/>code ranks, ties reported as ties"]
      RANK -- model flags risk / harmful --> SUP
      RANK --> LOOP["Loop: model turn with tools<br/>budget: 10 tool calls, 3 searches,<br/>duplicate calls reused"]
      LOOP --> REG{"registry.classify(tool)"}
      REG -- read_only --> RO["calculateTime, searchInformation (STUB)<br/>results fenced as untrusted"]
      REG -- reversible --> RV["createTask, retryFailedTasks,<br/>updateSituation, draftMessage<br/>run now, user notified, undoable"]
      REG -- "irreversible (or unknown)" --> PROP["sendMessage = PROPOSE only<br/>exact text frozen, nothing sent"]
      REG -- askUser --> ASK[Ask: up to 3 questions, run pauses]
      RO --> LOOP
      RV --> LOOP
      PROP --> LOOP
      LOOP --> REC["Recommend: final reply<br/>guardOutput (no PIN/OTP requests), no em dashes"]
    end

    REC --> UI["CLI shows reply + EXACT text of each proposed send"]
    UI -- "user types 'send'" --> CONF["actions.confirm(shownText)<br/>must match the frozen text byte for byte"]
    CONF --> EXE["actions.execute<br/>1 idempotency: already sent? provider lookup by key<br/>2 staleness: situation changed? confirmation expired?<br/>3 contact-frequency limit<br/>4 log attempt, then send"]
    EXE --> OUT[(MockOutbox: the outside world)]
    UI -- "update: ..." --> REA["Reassess: new situation version,<br/>confirmed-but-unsent actions flagged stale"] --> S1

    LOG[("Append-only log per situation<br/>data/situations/sid.jsonl<br/>meta plaintext, content AES-256-GCM")]
    RV -.-> LOG
    PROP -.-> LOG
    CONF -.-> LOG
    EXE -.-> LOG
```

### Where confirmation sits

Confirmation is **outside** the model loop, on purpose. The model's `sendMessage` tool only creates an `action_proposed` entry and gets back "PENDING_USER_CONFIRMATION, NOT SENT". There is no `confirm` tool, so no prompt injection or model mistake can confirm anything. The CLI (the UI) shows the exact frozen text; the user types `send`; `confirm()` then checks that the text the UI displayed matches the proposal byte for byte, and records the situation version at that moment. `execute()` is a separate call that re-checks everything before sending.

`sendMessage` takes only a `draft_id`, not free text. The text that goes out is the draft the user saw, never something the model rewrote between preview and send.

### Tool classification ([src/registry.ts](src/registry.ts))

| Tool | Class | Confirmation | Real or stub |
|---|---|---|---|
| `calculateTime` | read-only | none | real |
| `searchInformation` | read-only | none | **STUB** (canned results by keyword, clearly labelled, results treated as untrusted) |
| `createTask`, `retryFailedTasks` | reversible | notify (undo = `cancelTask`, appends `task_cancelled`) | real |
| `updateSituation` | reversible | notify (versions are append-only) | real |
| `draftMessage` | reversible | notify (a draft never leaves NextStep) | real, drafts only, has no transport |
| `sendMessage` | **irreversible** | exact text preview + explicit confirm | real lifecycle; the transport is a mock outbox |
| anything else | **irreversible** (fail-safe default) | never executed from the loop | |

### How pending and executed actions are stored

One append-only JSON Lines file per situation: `data/situations/<sid>.jsonl`. Nothing is ever rewritten; state is rebuilt by replaying the log ([src/views.ts](src/views.ts)). An irreversible action is a sequence of entries with the same `ref`:

```
action_proposed   meta: {tool, idempotencyKey, contentHash, situationVersion, draftId}   data: {exactText, message}
action_confirmed  meta: {situationVersion}          <- the version the user said yes to
action_attempt    meta: {idempotencyKey}            <- written BEFORE calling the transport
action_failed     meta: {error, outcomeUnknown}     <- or:
action_executed   meta: {providerMessageId, reconciled}
action_halted     meta: {reason: situation_changed | confirmation_expired | contact_frequency_limit}
action_cancelled  meta: {reason}
```

"Pending" means the latest entry is `proposed`, `confirmed`, `halted`, `failed` or `attempting`. "Executed" means an `action_executed` exists for that idempotency key. Because the attempt is logged before the send, a crash or network failure mid-send always leaves evidence to reconcile against.

Each entry has plaintext `meta` (statuses, versions, hashes) and an encrypted `payload` (the situation text, draft body, task titles). Why the split is there: see Jugaad.

---

## The blockers, and where each one is implemented

All of these are real code with tests, not comments. `npm test` runs them offline; `npm run demo:blockers` prints them as a narrative.

| # | Blocker | How | Code | Proof |
|---|---|---|---|---|
| 1 | Idempotency: confirm, network fails, retry | Key = sha256(situation id + action type + content hash). Before sending: already executed with this key? Return the original result. Earlier attempt with unknown outcome? Ask the provider for a message with this key (client reference) first; if found, mark it sent without resending. The mock provider deliberately does **not** dedupe, like SMTP or most chat APIs, so the protection is ours. | [src/actions.ts](src/actions.ts) `execute`, [src/tools/sendMessage.ts](src/tools/sendMessage.ts) | tests "network fails AFTER delivery" and "BEFORE delivery"; demo section 1; sample trace |
| 2 | Staleness recheck | Confirmation records the situation version. At execute: if the version moved (for example the teammate replied, recorded as an `inbound` version), halt with the list of changes and re-prompt. A confirmation older than 30 min also expires. Clock is injectable, so "10 minutes later" is simulated exactly. | `execute` step (c) | test "confirmed, 10 minutes pass, recipient replies"; demo section 2 |
| 3 | Step budget | Hard cap of 10 tool calls per run (env), 3 searches per run, model-turn cap, identical read-only calls reused instead of re-run. On hitting a cap the loop stops cleanly and returns what it found so far, with "say continue". | [src/agent.ts](src/agent.ts) loop | test "a model that keeps calling tools is stopped"; demo section 3 |
| 4 | Partial failure | `createTask` takes a batch, runs in order, stops at the first failure and returns `succeeded / failed / remaining` plus a recovery line. `retryFailedTasks(batchId)` creates only the missing tasks; per-task keys mean existing ones are never duplicated. Failures are injected by `Faults`, not faked in output. | [src/tools/createTask.ts](src/tools/createTask.ts) | test "3 of 5 tasks created before an error"; demo section 4 |
| 5 | Exact-text confirmation | Explicit `proposing` then `confirmed` then `executed` trace steps. The user sees `To / Subject / body` verbatim; confirming any other text is rejected; executing unconfirmed is rejected. | `proposeSend`, `confirm` | test "send is proposing -> confirmed -> executed"; sample trace |
| 6 | Prompt injection | Pasted text, inbound replies and search results are fenced in `<untrusted_content>` (fence cannot be closed from inside); a deterministic scanner flags instruction-shaped text and tells the model outside the fence; the final reply goes through `guardOutput`, which blocks any sentence asking the user to share a PIN/OTP/password. So even a fully fooled model cannot deliver the scam. | [src/untrusted.ts](src/untrusted.ts) | tests "even a fully fooled model cannot deliver a PIN request", "second-order injection"; live results below |
| 7 | Harmful requests | Deterministic policy screen runs before any model call: "fake medical excuse" and "message my ex until she replies" are refused with a short reason and an honest alternative. Paraphrases that slip past are caught by the model's assessment (`request_type: harmful`) and again inside `draftMessage`/`sendMessage`. A contact-frequency rule (max 2 unanswered messages to one person) enforces "until she replies" in code. | [src/policy.ts](src/policy.ts) | tests for both phrases (model is never called), paraphrase, contact limit |
| 8 | Determinism | temperature 0, low thinking, and the model only *extracts* problems; **code ranks them** with a fixed, explainable score. Same extraction, same order. | [src/priority.ts](src/priority.ts) | live results below |

The trace for every run uses exactly the five labels: `reasoning`, `asking`, `proposing`, `confirmed`, `executed`. Finer detail (policy refusal, staleness halt, budget stop) goes in a separate `kind` field, so the label set stays small and auditable.

`calculateTime` handles the two named edge cases with the real current time in the user's timezone (tests in [tests/time-and-injection.test.ts](tests/time-and-injection.test.ts)):
- **"tomorrow" at 11:55pm** is the next calendar day, with a note that it starts in 5 minutes. "10am tomorrow" at 11:55pm is 10h05m away, not a day. At 00:30, "tomorrow" is genuinely ambiguous (the user probably hasn't slept), so it returns the earlier date and flags it for confirmation.
- **"by Friday" said on a Friday** resolves to today and flags next Friday as the alternative. Rule for all ambiguity: pick the earlier date and ask, because being early costs slack and being late costs the deadline.
- Dates are computed in `Asia/Kolkata`, never the server's UTC date (at 00:30 IST the UTC date is still yesterday).

SCENARIO_RESULTS_PLACEHOLDER

---

## Key decisions (and the alternative I rejected)

**1. Hand-written loop instead of an agent framework.** Rejected: LangChain / LangGraph (and similar SDK "tool runners"). The whole point of this role is the gap between deciding and doing. With a framework, the confirmation gate becomes a callback inside someone else's loop, and I would have to explain that loop's retries, state and tool dispatch in the interview. A hand-written loop is about 250 lines, every branch is visible, and the safety-critical parts (confirmation, idempotency, staleness) do not live in the loop at all. I chose the simplest thing over the most sophisticated thing. The cost: I own retries, message formatting and provider differences myself (visible in the Gemini adapter).

**2. Append-only JSON log per situation instead of a database.** Rejected: Postgres (or SQLite). For a thin slice, a JSONL file per situation gives me the property I actually need (history is never overwritten, state is a replay) with zero setup. This is a deliberate scope cut. It has real limits: no concurrency control between two processes writing the same situation, a full-file read per operation, no indexing. For production I would move to Postgres with an `events` table (append-only, unique constraint on `(situation_id, idempotency_key, type)` so the database itself enforces "executed once"), per-user encryption keys in a KMS, and a transactional outbox for sends.

**3. Model: Gemini free tier by default, Claude supported.** The brief I started from specified Claude (Haiku 4.5, the current small/fast model). I built against it first, then switched the default to Gemini because I had no paid API credit, and Gemini has a free tier with tool calling. Rejected: Groq/Llama and OpenRouter free models, which are weaker at reliable structured tool calls and have less predictable rate limits. Because the loop talks to a one-method `ModelClient` interface, the switch was an adapter ([src/gemini.ts](src/gemini.ts)) and nothing in the safety harness changed. Default `gemini-3.8-flash` at thinking level `low`: `gemini-2.5-*` no longer accepts new API keys, and `gemini-3.5-flash-lite` is about 5x faster but a weaker reasoner, which matters more here than speed. Cost of this choice: on the free tier each model call took several seconds, so a full run takes tens of seconds (see "What I skipped").

**4. Code ranks the priorities, the model only extracts them.** Rejected: trusting the model's own "top priority". A fixed score (urgency + category, where people's health and fraud outrank deadlines, + deadline proximity from `calculateTime`) makes the ranking repeatable and explainable ("why is this first"), and ties are reported as ties instead of an invented order. The model's own pick is still recorded, and the trace says whether they agree.

**5. Rebuild the model context from the log on every run instead of resending the whole chat.** Each run sends the situation's versions, existing tasks, drafts and pending actions, not the full previous conversation. Rejected: an ever-growing message history. This keeps cost flat as a situation evolves, and it makes a run reproducible from the log alone.

---

## What I skipped, and why

- **No real message transport.** `sendMessage` goes to a mock outbox file. The lifecycle around it is real; the delivery is not. Plugging in email or WhatsApp is the easy part; getting "exactly once" right around it was the hard part, so that is where the time went.
- **No UI beyond a CLI.** The brief allows a runnable script, and the confirmation step is demonstrated in the CLI and in the saved traces.
- **Latency.** On the free Gemini tier a run takes tens of seconds (several model calls, each several seconds). The beta data says 38% of users leave at 11 seconds, so this would not ship as is. I did not add streaming or a "show the top priority from the first call, keep working in the background" mode. The first model call already produces the structured assessment and ranking, so that is where I would cut the wait.
- **Staleness is conservative, not semantic.** Any new situation version after confirmation halts the send, even an irrelevant one. A production version would diff the change against the message's recipient and topic. I chose false halts over false sends.
- **The policy screens are keyword rules plus the model's assessment.** They catch the brief's cases and obvious variants; a determined paraphrase can get past the keyword layer and then depends on the model's judgment (and the draft-level check). I did not build a separate classifier model.
- **searchInformation is a stub** with canned results, including one deliberately poisoned result to test second-order injection.
- **Single process.** No locking on the log files, so two processes writing one situation could interleave. Fine for a CLI; Postgres fixes it.
- **Time parsing covers common English and Hinglish forms** (tomorrow, kal, parso, weekdays, "5 tareekh", "10am", "in 3 hours"). Anything else returns an explicit "could not resolve, ask the user" instead of a guess.

---

## Curveball response

> **Placeholder.** The mid-challenge change from the team had not arrived when this README was written. This section will describe the change as received, what I changed (or pushed back on) and why.

---

## Jugaad: "delete everything about me" versus an append-only action log

**The problem the brief does not mention.** Two requirements quietly conflict. The action log is append-only, and the idempotency guarantee depends on it: "has this exact message already been sent?" is answered by reading history. But a user in distress may pour sensitive things into this app (a parent in hospital, self-harm signals, money trouble), and India's DPDP Act gives them the right to have their data erased. If "delete everything" deletes the log, the next retry of a half-finished send finds no history, and **the message goes out a second time.** If it does not delete the log, sensitive text stays forever.

**What I built: crypto-shredding with a meta/content split** ([src/store.ts](src/store.ts)).
- Every log entry is split into plaintext `meta` (status, timestamps, version numbers, the idempotency key, which is a hash) and a `payload` with the actual content, encrypted with AES-256-GCM under a key that belongs to that one situation.
- `forget(sid)` (CLI command `forget`) deletes the situation's key and its runtime traces (which contain prompts and model output in plaintext), and appends an `erasure` marker. The content in the log becomes permanently unreadable, and new content can no longer be written under that id.
- The meta survives. So a late retry of an already-sent message is still recognised and suppressed. The test "'forget me' makes content unreadable but still prevents a double send" proves both halves.
- Side benefit: sensitive content is encrypted at rest from the start, not only after erasure.

**Honest limits.** The key file sits next to the data here; in production it belongs in a KMS, with per-user keys. A message that was already sent cannot be recalled from the recipient; the product should say so when the user asks to delete. The committed sample traces in this repo are demo artifacts and are not covered by `forget`.

---

## AI disclosure

**Tools used.** Claude Code (Anthropic's coding agent, running the Claude Opus 5.5 model) wrote most of the code, tests and this README from a detailed brief I wrote. The runtime model the agent uses is Gemini (Google), with Claude supported as an alternative.

**What I asked it to do.** I gave it my own build brief: the stack (Node + TypeScript, no agent framework, JSON log, Claude with the model name from env), the loop, the tool list with sendMessage as a separate irreversible tool, all 8 blockers to implement as real code, the evaluation against the 7 scenarios, and the README structure. I also set constraints: no em dashes anywhere, and no AI listed as a commit co-author.

**What I accepted, modified, or rejected.**
- Accepted: the overall design (propose, confirm, execute outside the model; code-ranked priorities; the meta/content split for erasure), the test suite, and the scripts.
- Changed direction: the brief specified Claude. I had no paid API credit, so I asked for a free alternative, chose Gemini, and had it build the adapter instead of paying for Claude credits. Claude support stayed in.
- Rejected: its suggestion to stay on Claude for less deadline risk (I preferred zero cost), and the default AI co-author trailer on commits.

**Where the AI got things wrong, and how each was fixed.**
1. **It picked a model that no longer exists for new users.** From its own knowledge it defaulted the Gemini adapter to `gemini-2.5-flash`. The first live call returned HTTP 404: "no longer available to new users". It fixed this by querying the models endpoint with my key, probing candidate models with a real forced tool call, and switching to `gemini-3.8-flash`. That also exposed a second wrong assumption: Gemini 3 cannot turn thinking off (`thinkingBudget: 0` is a Gemini 2.5 setting; `thinkingLevel: "minimal"` is rejected by 3.8-flash), so the adapter now sets `thinkingLevel: "low"`.
2. **A real bug in the step budget, caught by its own test.** The cap on model turns (8) was lower than the cap on tool calls (10), so a model stuck in a loop hit the turn cap first, and the run reported `completed` instead of a clean budget stop. The failing test made it visible; the fix derives the turn cap from the tool cap and treats "no final reply" as budget exhaustion.
3. **Clarifying answers lost their questions.** Each run rebuilds context from the log, but the questions the agent asked were not in the log, so the answers would have reached the model without the questions they answer. It caught this while reviewing the flow and now stores the questions next to the answer.
4. Smaller: a bulk edit done through a Python script mangled a TypeScript template string (the compiler caught it), and the built-in PDF reader could not open the challenge PDF, so it extracted the text with `pypdf` instead.
