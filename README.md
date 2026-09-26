# NextStep Agent (Role 06: AI Application Developer)

An agent that takes real actions for an overwhelmed user (works out deadlines, creates tasks, drafts messages) but never lets an irreversible action happen until the user has seen the exact text and confirmed it.

The core idea is simple: **thinking about an action and performing it are different code paths.** The model can reason, call read-only tools, change NextStep's own reversible state, and *propose* a send. It cannot send. Sending lives in a separate lifecycle (propose, confirm, execute) that the model has no tool for, and every step of it is written to an append-only log.

- Language: Node.js + TypeScript (runs directly on Node 22.18+ type stripping, no build step)
- Dependencies: `@anthropic-ai/sdk` only (plus `typescript` and `@types/node` for type checking)
- Model: Claude via native tool use, model name from `ANTHROPIC_MODEL`
- No agent framework: the loop is about 250 lines in [src/agent.ts](src/agent.ts)

---

## Setup

Requirements: Node.js 22.18 or newer (developed on Node 24).

```bash
npm install
```

Copy `.env.example` to `.env` and set your key:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5        # optional, this is the default
NEXTSTEP_CANDIDATE_ID=you@example.com   # optional, sent as X-Candidate-Id to the mock API
```

| Command | Needs API key | What it does |
|---|---|---|
| `npm test` | no | 31 offline tests: every blocker, calculateTime edge cases, injection guards, erasure |
| `npm run demo:blockers` | no | Narrated run of blockers 1 to 5 and 7 against the real harness with a scripted model. Writes [results/blockers-demo.md](results/blockers-demo.md) |
| `npm run typecheck` | no | `tsc` strict type check |
| `npm run agent` | yes | Interactive CLI. Describe a situation, answer questions, review and confirm sends. `update: ...` to reassess, `forget` to erase |
| `npm run scenarios` | yes | Runs all 7 shared scenarios, saves [results/scenarios/](results/scenarios/) |
| `npm run trace:sample` | yes | One full labelled run of scenario 7, saves [traces/](traces/) |
| `npm run determinism` | yes | Same input 5 times, saves [results/determinism.md](results/determinism.md) |
| `npm run injection` | yes | Live prompt-injection test (pasted and second-order), saves [results/injection-live.md](results/injection-live.md) |

Set `NEXTSTEP_SHOW_TRACE=1` to print each labelled trace step live in the CLI.

---

RESULTS_AND_REST_PLACEHOLDER
