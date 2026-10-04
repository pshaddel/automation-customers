# automation-customers

Backend design for the Blotato take-home ([docs/CHALLENGE.md](docs/CHALLENGE.md)): automations that start when someone comments on a social media post, such as replying to a "pricing" comment, DMing the commenter for their email, waiting for it, and sending a link. Bun + Elysia, Postgres, BullMQ on Redis.

This page covers the **architecture**, **data model** and **execution model**. More detail:
- [docs/automation.md](docs/automation.md): the full design, every edge case and the reasoning behind each decision
- [docs/development.md](docs/development.md): running the project, trying the flow (dashboard or curl), the API, auth and limitations

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.3, Docker with Compose.

```sh
cp .env.example .env && docker compose up -d && bun install
bun run db:migrate && bun run db:seed && bun run dev
```

Open http://localhost:3000, sign in as `alice` / `Password123!`, and on the dashboard use **Send sample trigger**, then **Send sample reply** on the waiting run, to walk through the brief's flow. Tests: `bun test`.

## Architecture

```
                 ┌──────────────────────── API process (Bun + Elysia) ─────────────────────────┐
 Instagram ─────►│ webhooks: normalize payload, drop our own echoes, enqueue 1 job/event, 200  │
 webhooks        │ automations API: CRUD, draft → publish, runs (session auth)                 │
                 └──────────────────────────────────┬──────────────────────────────────────────┘
                                                    │ BullMQ on Redis
              ┌─────────────────────────────────────┼───────────────────────────────────┐
              ▼                                     ▼                                   ▼
     automation-events                      automation-steps                 automation-wait-timeouts
     event worker:                          step runner:                     timeout worker (delayed jobs):
     match event → listeners,               run one step, record result,     end a wait whose deadline
     start or resume runs                   enqueue the next step            passed, follow next.timeout
              │                                     │                                   │
              └──────────────── Postgres: definitions, runs, listeners (source of truth) ┘
                                                    │
                                 social-media client: sendDm(), commentOnPost()
```

An automation is **data, not code**: a graph of steps that the user builds. The brief's flow is one automation; branching, loops and timeouts are other graphs on the same engine, with no engine changes.

- **Webhooks do no work.** They normalize the platform payload into an event, enqueue one job and answer `200`. Matching, sending and waiting all happen in workers, so a slow platform call never blocks a webhook and every piece of work can be retried.
- **Postgres is the source of truth, Redis only carries work.** Every job checks the database before acting and is safe to run twice, so a lost, duplicated or retried job can't corrupt a run or send a message twice.
- **One job per event and one job per step**, not one per run. A run waiting days for a reply holds no worker, and a failing step retries alone instead of replaying messages that were already sent.
- **Pluggable steps.** Each step type (`comment_received`, `reply_to_comment`, `send_dm`, `message_received`) lives in `src/automations/steps/<step_type>/`, is registered in one registry, and is pure: input in, output or error out. The step runner owns every database write, retry and failure decision, so a new step type can't get those wrong.
- **The engine knows no platform.** Accounts, contacts and posts live in step config. A trigger turns its config into an opaque **correlation key** (`account:<accountId>`, `dm:<accountId>:<contactId>`), and the engine only compares strings. A new platform means new step types, not new columns.
- **Scaling:** workers run inside the API process by default, or as their own process (`bun run worker`) so they scale independently of the API.
- **Code is organised by domain:** `src/automations/` (engine, API, steps) and `src/social-media/` (simulated webhooks, dummy client).

## Data model

```
users ─┬─< automations ─┬─< automation_versions ─< automation_steps
       │                │          (draft or published, immutable once published)
       │                ├─< automation_triggers      listeners: entry (start runs) and wait (resume a run)
       │                └─< automation_runs ─< automation_step_runs
       └─< sessions
automation_unmatched_events                          replies that arrived before anyone waited for them
```

| Table | Purpose | Key columns and constraints |
|---|---|---|
| `automations` | What the user owns and turns on or off | `user_id`, `name`, `active`, `current_version_id`, `deleted_at` (soft delete) |
| `automation_versions` | Immutable snapshot of the steps. Runs pin a version, so editing never breaks a run in progress | `version`, `entry_step_id`, `published_at` (null = the draft; at most one draft per automation) |
| `automation_steps` | One node of the graph | `key` (readable, stable across versions, `UNIQUE (version_id, key)`), `step_type`, `config` jsonb (may hold templates such as `{{trigger.contactId}}`), `next` jsonb: outcome → step key |
| `automation_triggers` | Listeners: "when event X with correlation key K arrives, continue at step S" | `run_id` null = entry listener (one per active automation); set = a run waiting here (one per run). `event_type`, `correlation_key` (indexed together), `expires_at` for wait timeouts |
| `automation_runs` | One execution of a version, started by one event | `version_id` (pinned), `trigger_event_id`, `subject_key` (the contact), `status`, `current_step_id`, `context` jsonb (`{ trigger, steps: { <key>: output } }`), `step_count`. `UNIQUE (automation_id, trigger_event_id)` blocks duplicate webhooks; a partial unique index allows one active run per contact per automation |
| `automation_step_runs` | Log of each step execution, and its idempotency record | `sequence` (`UNIQUE (run_id, sequence)`; loops repeat steps), `status`, `attempt`, `input`, `output`, `outcome`, `error` |
| `automation_unmatched_events` | Events that matched no listener, held so a run that starts waiting a moment later can still claim them | primary key `(event_type, event_id, correlation_key)`, `event` jsonb, `received_at`; kept 24h |

Why this shape:
- **Versions instead of mutable steps.** Published versions are immutable; edits go to a draft that is a copy of the published version (copy-on-write). Publishing moves the entry listener to the new version, and runs already in progress finish on the version they started with.
- **`next` as an outcome → key map** on each step allows branches (`ok`, `timeout`, `error`) and loops without an edges table. Keys rather than ids mean copying a version needs no remapping.
- **One listeners table for starting and resuming runs.** "An event continues a graph" is one mechanism, whether the graph is new (entry) or paused (wait).
- **Step config schemas live in code** (a zod `inputSchema` per step type), not in the database. They are checked when a version is published and again before a step runs.
- Status columns are `text` + `CHECK` rather than Postgres enums, so a new value can be added inside the single transaction a migration runs in.

The brief's automation as rows of `automation_steps` (also the seeded demo, `src/automations/pricing-example.ts`):

```
key         step_type          config                                                             next
trigger     comment_received   { accountId: "acc_1", matchMode: "contains", keyword: "pricing" } { ok: reply }
reply       reply_to_comment   { commentId: "{{trigger.commentId}}", text: "Sent you a DM!" }   { ok: ask }
ask         send_dm            { contactId: "{{trigger.contactId}}", text: "What's your email?" } { ok: wait_email }
wait_email  message_received   { contactId: "{{trigger.contactId}}", match: "email",
                                 timeoutSeconds: 82800 }                                         { ok: send_link, timeout: remind }
send_link   send_dm            { contactId: "{{trigger.contactId}}", text: "Here's your link…" } {}
remind      send_dm            { contactId: "{{trigger.contactId}}", text: "Still interested?…" } {}
```
(`accountId: "{{trigger.accountId}}"` omitted from the action steps for brevity.)

## Execution model

| Queue | One job per | Job id (idempotent enqueue) |
|---|---|---|
| `automation-events` | incoming webhook event | `<eventType>-<eventId>` |
| `automation-steps` | step of a run | `<runId>-<sequence>` |
| `automation-wait-timeouts` | wait with a timeout, delayed until its deadline | `timeout-<runId>-<sequence>` |

All jobs get 3 attempts with exponential backoff.

**A run of the brief's flow:**
1. **Comment webhook** → event job. It builds the event's correlation keys (`account:acc_1`), loads matching listeners and asks each trigger's `match()` (keyword filter). The entry listener matches, so it creates a run (status `running`, `context.trigger` = the comment) and enqueues `reply`.
2. **Step jobs** run `reply` (`commentOnPost`), then `ask` (`sendDm`). Each one resolves its config templates against the run context, executes, and in one transaction records the step run, stores the output in `context.steps.<key>`, bumps `step_count` and moves `current_step_id` to `next[outcome]`. After the commit it enqueues the next step.
3. **`wait_email` is a trigger step**, so instead of executing it inserts a wait listener on `dm:acc_1:<contactId>` with `expires_at = now() + 23h`, sets the run to `waiting`, and schedules a delayed timeout job. No worker is held while waiting.
4. **Message webhook "hi"** → the listener's `match: email` rejects it, so the event is held as unmatched and the run keeps waiting. **"me@x.com"** → the listener matches. It is claimed with `DELETE ... RETURNING`, the run goes back to `running`, and `send_link` is enqueued. Wait listeners are checked before entry listeners, so a contact who DMs "pricing" mid-flow doesn't start a second run.
5. `send_link` has no `next`, so the run is `completed`. **If no email arrives in time,** the timeout job claims the listener instead, the step finishes with outcome `timeout`, and the run goes to `remind`.

Run status: `running ⇄ waiting → completed | failed | cancelled` (cancelled when the automation is paused or deleted).

**Reliability and concurrency:**
- **Duplicate webhooks:** the event job id dedupes while the job exists, and `UNIQUE (automation_id, trigger_event_id)` dedupes after it's gone.
- **Retries never repeat a side effect that was recorded.** A step run that `succeeded` at `(run_id, sequence)` is never executed again; a retry only re-enqueues the next step. That also covers a crash between the commit and the enqueue. The gap left is a crash between the platform call and the database write, so each call carries an idempotency key (`<runId>-<sequence>`) the real client can dedupe on.
- **State transitions are serialised:** each one locks the run row (`SELECT ... FOR UPDATE`) inside a transaction, so a resume, a step completion and a cancellation can't interleave. A job for a run that is no longer `running`, or for a step that isn't current, does nothing.
- **Exactly one winner per wait:** a reply, a second simultaneous reply and the timeout all claim the same listener with `DELETE ... RETURNING`. Only one gets the row; the others do nothing. Matching ignores expired listeners, so a reply after the deadline can't resume the run even if the timeout job runs late.
- **A reply that beats the wait:** `ask` sends the DM in one job and `wait_email` registers the listener in the next. A fast reply in that gap matches nothing, so it's held in `automation_unmatched_events`, and the wait claims it (if it arrived after the question was sent and passes `match()`) instead of waiting. Both sides first take a per-conversation advisory lock, so neither can miss the other's uncommitted row. Lock order everywhere: conversation, then listener, then run row, so nothing deadlocks.
- **Failures:** the step runner records the failed attempt and rethrows so BullMQ retries. On the last attempt (or an unrecoverable error such as invalid input) the run follows `next.error` if the step has one, or is marked `failed` and its listener deleted. This runs inside the job, not in an in-memory `failed` event that a crash would lose.
- **Runaway graphs:** a loop that never ends fails the run after 50 steps. Publishing validates the graph (one entry trigger, known step types, valid configs and templates, every `next` target exists and every step is reachable).
- **Known gap:** if the process dies at exactly the wrong moment (the failure handler failing, or a crash right after a reply resumes a run), a run can stay `running` with no job. The fix is a periodic sweep for stale runs; see [Limitations](docs/development.md#limitations).

## Write-up AI Usage
- I started with a piece of paper and pencil, drawing the steps and the flow I thought that makes sense. it was actually an advantage that I have extensively worked with n8n in the past, I re-used some of the ideas that I have seen in n8n implementation.
- I started the project from a Bun template I use. I started to create a automation.md file to bring my ideas together. LLM was helpful to generate the code based on the current implementation, I also asked for super simple html, css, js to create a dashboard to test the flow. I also asked for some code to generate a random comment and random DM to test the flow.
- I used claude code to steer the implementation of the code.
