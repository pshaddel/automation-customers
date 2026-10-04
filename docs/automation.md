# Automation design

Design and implementation plan for comment-triggered automations (brief: `CHALLENGE.md`). **Implemented**: everything in this document, except where the [Edge cases](#edge-cases) table marks a limitation. See [Implementation](#implementation) for the build plan and what deviated from it.

## Goals

- A user builds an automation as a **graph of steps** that starts when an event (e.g. a comment) matches.
- Automations can **branch** (e.g. "is this an email?") and **loop** (e.g. "ask again").
- An automation can **pause mid-flow** until something happens (e.g. the contact replies), then continue.
- The engine is **generic**: platform details (accounts, contacts) live in step config and step code, not in table columns.
- **All async work runs on BullMQ**: one job per incoming event, and one job per step.
- Editing an automation never breaks runs that are already in progress.
- Every run is retry-safe: a duplicate webhook or a retried job never sends a message twice.

## Concepts

| Term | Meaning |
|---|---|
| **Automation** | What the user owns and turns on or off. |
| **Version** | An immutable snapshot of an automation's steps. Runs pin a version. |
| **Step** | One node in the graph. Its `step_type` selects an implementation in `src/automations/steps/<step_type>/`. |
| **Trigger step** | A step that waits for an event. As the entry step it **starts** runs; in the middle of the graph it **pauses** its run until a matching event arrives. |
| **Action step** | A step that does something (reply, send a DM) and finishes with an outcome. |
| **Listener** | A row in `automation_triggers`: "when event X with correlation key K arrives, continue at step S". |
| **Run** | One execution of a version, started by one event. |
| **Step run** | One execution of one step inside a run (log + idempotency record). |

## Code layout

Organised by domain, as `CLAUDE.md` requires:

```
src/
  social-media/
    social-media.client.ts      sendDm(), commentOnPost(): dummy platform calls (log + return fake ids)
    webhooks.route.ts           POST /api/social-media/webhooks/comments, POST /api/social-media/webhooks/messages
    webhooks.service.ts         parse Instagram-shaped payload → normalized event → enqueue event job
    webhooks.schema.ts          Elysia `t` schemas for the two payloads
  automations/
    steps/
      step.types.ts             ActionStep / TriggerStep interfaces
      registry.ts               step_type → implementation (the only place the names are mapped)
      comment_received/         comment_received.step.ts + __tests__/
      reply_to_comment/
      send_dm/
      message_received/
    template.ts                 resolves {{trigger.*}} / {{steps.<key>.*}} in step config
    automations.route.ts        CRUD for automations and steps, publish, runs (see API)
    automations.schema.ts       Elysia `t` request/response schemas
    automations.service.ts      automations, drafts, steps, publish, entry listeners
    validation.ts               graph validation run at publish
    runs.service.ts             runs, step runs, wait listeners, unmatched events (used by the workers)
    automation-events.queue.ts  queue + enqueueEvent()
    automation-events.worker.ts matches an event to listeners (one job per event)
    automation-steps.queue.ts   queue + enqueueStep()
    automation-steps.worker.ts  the step runner (one job per step)
    automations.seed.ts         demo "pricing" automation for the seed user
```

## Step catalog

The `step_type` values below are **permanent**: they are stored in `automation_steps.step_type`, and the folder name under `steps/` must match. Never rename one. If a step's behaviour has to change incompatibly, add a new type (e.g. `send_dm_v2`) and keep the old one working for versions that use it.

| `step_type` | Kind | Input (config after templates) | Output | Outcomes | Calls |
|---|---|---|---|---|---|
| `comment_received` | trigger | `accountId`, `matchMode` (`any` \| `contains` \| `exact`), `keyword?`, `postId?` (null = any post) | `accountId`, `postId`, `commentId`, `contactId`, `text` | `ok` | — |
| `reply_to_comment` | action | `accountId`, `commentId`, `text` | `replyId` | `ok` | `commentOnPost()` |
| `send_dm` | action | `accountId`, `contactId`, `text` | `messageId` | `ok` | `sendDm()` |
| `message_received` | trigger | `accountId`, `contactId`, `match` (`any` \| `email`), `timeoutSeconds?` (1–86400; omitted = wait indefinitely) | `messageId`, `text`, `email` (null when `match: any` finds none); on timeout `{ timedOut: true }` | `ok`, `timeout` | — |

How the two triggers listen:

| `step_type` | Event type | Correlation key | Match filter |
|---|---|---|---|
| `comment_received` | `comment_received` | `account:<accountId>` | keyword (by `matchMode`) and optional `postId` |
| `message_received` | `message_received` | `dm:<accountId>:<contactId>` | `email`: the text contains an email address |

In v1, `comment_received` is only allowed as the entry step, and `message_received` only mid-flow. Both rules are checked when a version is published.

### Step interfaces

Step implementations know nothing about queues, retries, the database or the run's status. They are pure: input in, then output out or an error thrown.

```ts
interface ActionStep<Input, Output> {
  kind: "action";
  type: string;                    // the permanent step_type
  inputSchema: ZodType<Input>;     // checked at publish (config) and before execute (input)
  outcomes: readonly string[];     // for publish-time validation of `next`
  execute(input: Input, ctx: StepContext): Promise<{ outcome: string; output: Output }>;
  // throw = failure; throw UnrecoverableError = don't retry
}

interface TriggerStep<Input, Event, Output> {
  kind: "trigger";
  type: string;
  eventType: string;
  position: "entry" | "wait";                        // only first step / only mid-flow
  inputSchema: ZodType<Input>;
  outcomes: readonly string[];
  correlationKey(input: Input): string;              // what a listener for this input is stored under
  eventKeys(event: Event): string[];                 // keys an incoming event can match (same format)
  match(event: Event, input: Input): Output | null;  // null = this event doesn't match
  subjectKey(event: Event): string;                  // who a run started by this event is about
}
```

`StepContext` carries `runId`, `sequence`, `attempt`, an `idempotencyKey` (`<runId>-<sequence>`) to pass to platform calls, and the social-media client, so tests can inject a fake.

## Tables

All tables use `id uuid` primary keys and `created_at`/`updated_at` with the `set_updated_at()` trigger. Status-like columns are `text` + `CHECK` rather than Postgres enums: adding an enum value can't be used in the same transaction, and every migration here runs in one.

### `automations`

| Column | Notes |
|---|---|
| `id` | |
| `user_id` | FK `users`. The owner. |
| `name` | |
| `active` | boolean. Only active automations have entry listeners. |
| `current_version_id` | FK `automation_versions`, nullable until the first publish. |
| `deleted_at` | Soft delete. |

### `automation_versions`

| Column | Notes |
|---|---|
| `id` | |
| `automation_id` | FK `automations`. |
| `version` | int, `UNIQUE (automation_id, version)`. |
| `entry_step_id` | FK `automation_steps`, the entry trigger. |
| `published_at` | Null = draft (editable). Once set, the version and its steps are immutable. |

To edit a published automation, copy its steps into a new draft version, edit it, then publish it, which points `automations.current_version_id` at it.

### `automation_steps`

| Column | Notes |
|---|---|
| `id` | |
| `version_id` | FK `automation_versions`. |
| `key` | Readable id, unique per version, `^[a-z][a-z0-9_]*$` (e.g. `ask`). Stays the same across versions. Templates read outputs as `{{steps.ask.messageId}}`. |
| `step_type` | A value from the [step catalog](#step-catalog). |
| `label` | Display name. |
| `config` | jsonb. Values can be templates that reference the run context. |
| `next` | jsonb, `{ "<outcome>": "<step key>" }`. Keys, not ids: keys are unique per version, so copying a version needs no remapping, and the API addresses steps by key. An outcome with no entry ends the run. Any step may also have an `error` key; see [Failure handling](#failure-handling). |

### `automation_triggers` (listeners)

- **Entry listener** (`run_id IS NULL`): created when a version is published and its automation is active, deleted when it's paused, deleted or replaced by a new version. A match **creates a run**.
- **Wait listener** (`run_id` set): created by the step runner when a run reaches a mid-flow trigger. A match **resumes that run** and deletes the row.

| Column | Notes |
|---|---|
| `id` | |
| `automation_id`, `version_id`, `step_id` | The trigger step that owns this listener. |
| `run_id` | Null = entry listener. Unique when set: a run waits on at most one trigger. |
| `event_type` | From the trigger's implementation. |
| `correlation_key` | An opaque string from the trigger's `correlationKey(input)`. |
| `expires_at` | Wait listeners only: when the wait times out (`timeoutSeconds`). Null = never; always null for entry listeners. Expired listeners are ignored by matching. |

Index `(event_type, correlation_key)`. The engine only compares strings. Content filters (keyword, email) are checked in code by the trigger's `match()`, after the indexed lookup narrows the candidates.

### `automation_runs`

Runs are an append-only log, so there's no `deleted_at`.

| Column | Notes |
|---|---|
| `id` | Also the trace id for logs. |
| `automation_id`, `version_id` | The version is pinned when the run starts. |
| `trigger_event_id` | Id of the event that started the run. |
| `subject_key` | Who the run is about, e.g. `contact:<contactId>`. Used to dedupe runs. |
| `status` | `running`, `waiting`, `completed`, `failed`, `cancelled`. |
| `current_step_id` | The step being executed, or the trigger being waited on. |
| `context` | jsonb, `{ trigger: <entry trigger output>, steps: { <key>: <output> } }`. |
| `step_count` | Guard against infinite loops. |
| `started_at`, `finished_at`, `error` | |

Constraints:

- `UNIQUE (automation_id, trigger_event_id)`: a duplicate event can't start a second run.
- `UNIQUE (automation_id, subject_key) WHERE status IN ('running','waiting')`: one active run per contact per automation.

### `automation_step_runs`

| Column | Notes |
|---|---|
| `id` | |
| `run_id`, `step_id` | |
| `sequence` | Position in the run (1, 2, 3, ...). `UNIQUE (run_id, sequence)`; loops can run the same step more than once. |
| `status` | `running`, `succeeded`, `waiting`, `failed`. |
| `attempt` | |
| `input`, `output` | jsonb. `output` stores side-effect results such as the platform message id. |
| `outcome` | Which `next` key was followed. |
| `error`, `started_at`, `finished_at` | |

### `automation_unmatched_events`

Events that matched no listener, held so a run that starts waiting just after can still claim them (see [Unmatched events](#unmatched-events)). Only event types some wait trigger listens for are stored (`isWaitEventType()` in the registry: today `message_received`), never comments. Rows are claimed with `DELETE ... RETURNING`, like listeners, so there's no `id`, status, `updated_at` or `deleted_at`.

| Column | Notes |
|---|---|
| `event_type`, `event_id` | The platform event. |
| `correlation_key` | One row per key from `eventKeys(event)`. Primary key `(event_type, event_id, correlation_key)`, so a retried event job inserts nothing new. |
| `event` | jsonb, the normalized event, passed to the trigger's `match()` later. |
| `received_at` | When the webhook arrived: the event job's enqueue time, not when the job ran. |
| `created_at` | |

Index `(event_type, correlation_key, received_at)` for the lookup, and `(received_at)` for cleanup. Migration `005_unmatched_events.sql`.

## Webhooks (simulated Instagram)

Two endpoints stand in for Instagram's webhook calls, so the flow can be exercised end to end. Real Instagram sends everything to one callback URL; two routes keep the dummy simple.

| Route | Body (Instagram-shaped) | Normalized event |
|---|---|---|
| `POST /api/social-media/webhooks/comments` | `{ object: "instagram", entry: [{ id, time, changes: [{ field: "comments", value: { id, text, from: { id }, media: { id } } }] }] }` | `comment_received`: `eventId`, `accountId`, `postId`, `commentId`, `contactId`, `text` |
| `POST /api/social-media/webhooks/messages` | `{ object: "instagram", entry: [{ id, time, messaging: [{ sender: { id }, recipient: { id }, timestamp, message: { mid, text } }] }] }` | `message_received`: `eventId`, `accountId` (`recipient.id`), `contactId` (`sender.id`), `messageId`, `text` |

`webhooks.service.ts`:

1. Normalizes each change or message into an event. Instagram has one DM conversation per (account, contact), and its message webhook carries no thread id, so a conversation is identified by `accountId` + `contactId`. No synthetic chat id is needed.
2. Drops events from our own account: comments whose `from.id` is the account, and message echoes. Otherwise our own replies would trigger automations.
3. Enqueues one `automation-events` job per event, and responds `200` right away. No matching happens in the request.

The dummy endpoints skip Instagram's `X-Hub-Signature-256` check; a real integration must verify it.

`social-media.client.ts` exposes `sendDm({ accountId, contactId, text, idempotencyKey })` → `{ messageId }` and `commentOnPost({ accountId, commentId, text, idempotencyKey })` → `{ replyId }`. Both log and return fake ids; the brief says these platform calls already exist.

## Execution model

Two queues, both using `DEFAULT_JOB_OPTIONS` (3 attempts, exponential backoff from 1s). Job ids are deterministic so enqueues are idempotent (BullMQ forbids `:` in custom ids, hence `-`):

| Queue | One job per | Data | `jobId` |
|---|---|---|---|
| `automation-events` | Incoming event | Normalized event | `<eventType>-<eventId>` |
| `automation-steps` | Step of a run | `{ runId, stepId, sequence }` | `<runId>-<sequence>` |
| `automation-wait-timeouts` | Wait whose trigger has `timeoutSeconds`; **delayed** until the listener's `expires_at` | `{ runId, stepId, sequence }` | `timeout-<runId>-<sequence>` |

### Event job: matching an event to listeners

Steps 1, 2 and 4 run in one transaction. For an event type a wait trigger listens for, it first takes the conversation lock on each of the event's keys (see [Unmatched events](#unmatched-events)).

1. Build the event's candidate keys from every trigger type for its event type (`eventKeys(event)`; a DM gives `dm:<accountId>:<contactId>`). Load the live listeners with those keys, then keep those whose trigger `match()` returns an output. An entry listener matches against its step's config, which has no templates. A wait listener matches against the input its step run resolved when the run started waiting.
2. **Wait listeners first.** For the oldest match, in one transaction:
   - claim it with `DELETE ... WHERE id = $1 RETURNING`
   - set the run from `waiting` to `running`
   - mark the trigger's step run `succeeded`, with the match output
   - store that output in `context.steps[<key>]`

   After the commit, enqueue the next step. Stop here.
3. **Otherwise, entry listeners** (after the commit). For each match, create a run (`ON CONFLICT DO NOTHING` on the unique constraints), with the match output as `context.trigger` and a `succeeded` step run for the trigger at sequence 1. Then enqueue the step after the trigger.
4. **Nothing matched:**
   - a wait trigger listens for this event type → store it in `automation_unmatched_events`, return `{ matched: "held" }` and log `automation_event_held`. A run that starts waiting later may claim it.
   - otherwise (comments) → complete the job and log `automation_event_unmatched`

   Nothing is retried on a miss. The normal 3 attempts are only for real errors.

### Step job: the runner

1. Load the run and step. If the run isn't `running`, do nothing (it was cancelled or failed).
2. If the step run for `(run_id, sequence)` already `succeeded`, skip to step 6. This job is a retry of one that crashed after committing. If there's no step run and `run.current_step_id` isn't this step, the job is stale; do nothing.
3. Look up the implementation in the registry. An unknown `step_type` raises `UnrecoverableError`.
4. Resolve the config's templates against `run.context` and validate it with `inputSchema`. A missing template value or invalid input raises `UnrecoverableError`. Record the step run as `running`, with this attempt number and the input.
5. Branch on the step's kind:
   - **Trigger step (mid-flow):** in one transaction (`waitOnTrigger()`), take the conversation lock on `correlationKey(input)`, then lock the run.
     - **A held event answers it** (see [Unmatched events](#unmatched-events)): claim the event, mark the step run `succeeded` with the match output and outcome `ok`, and advance the run as an action step would. After the commit, enqueue `next.ok`. No listener and no timeout job are created.
     - **Otherwise:** mark the step run `waiting`, insert the wait listener, and set the run to `waiting`. After the commit, if the input has `timeoutSeconds`, enqueue the delayed timeout job (see [Wait timeouts](#wait-timeouts)). Done; the event job resumes it later, or the timeout job ends the wait.
   - **Action step:** call `execute(input, ctx)`. Then, in one transaction:
     - mark the step run `succeeded`, storing the output and outcome
     - store the output in `context.steps[<key>]`
     - increment `step_count`, failing the run if it goes over the cap (e.g. 50)
     - set `current_step_id = next[outcome]`, or mark the run `completed` if there's no next step
6. After the commit, enqueue `next[outcome]` with `sequence + 1`, if there is one.

### Unmatched events

A run sends its question (`ask`, a `send_dm`) in one step job and registers the wait listener in the next one. A fast reply can arrive in between, and if the steps queue is backed up or the worker crashes after sending the DM, that gap can last seconds or longer. Retrying the match only covers a fixed window, so the event is stored instead and the wait looks for it.

- **Held:** an event that matches no listener, of a type some wait trigger listens for, is stored in `automation_unmatched_events` with the time the webhook arrived.
- **Claimed:** when a run reaches a mid-flow trigger, `waitOnTrigger()` looks for held events with the same event type and correlation key, oldest first, and keeps the first that:
  - arrived no earlier than the **previous step run started** (`received_at >= started_at` of sequence − 1). A message sent before the question was asked can't answer it, e.g. an email the contact DMed on their own before commenting.
  - passes the trigger's `match()` against the resolved input. A held "hi" doesn't answer `match: email` and stays held.

  It deletes every row of that event, so one event can't answer two runs, and the run continues without waiting.
- **The conversation lock:** both transactions (the event job's match-or-hold and `waitOnTrigger()`'s claim-or-wait) first take `pg_advisory_xact_lock(hashtext(correlation_key))`. Without it, each could miss the other's uncommitted row (the event sees no listener, the wait sees no held event) and the reply would be lost. With it, one commits first and the other sees its row. Lock order everywhere: **conversation, then listener, then run row**. Keys are sorted when an event has several. A hash collision only serialises two unrelated conversations.
- **Cleanup:** the lookup ignores rows older than 24h (`UNMATCHED_EVENT_TTL_HOURS`), and each insert deletes them. The race only needs seconds, so no separate job.
- **Clocks:** `received_at` comes from the app (BullMQ's enqueue time) and `started_at` from Postgres. They only need to agree to well under the time it takes to send a DM and get a reply.

### Wait timeouts

A wait can be bounded by setting `timeoutSeconds` in the trigger step's config (`message_received` only for now; a trigger type opts in through `TriggerStep.timeoutSeconds(input)`). It's opt-in: without it the run waits indefinitely, as before, so existing versions keep their behaviour and no new step type is needed (the field and the outcome are additive).

The deadline is stored twice, with different jobs: `automation_triggers.expires_at` is the **source of truth**, and the delayed BullMQ job is only the **wake-up call** that moves the run on.

- **Limit:** `inputSchema` caps it at 86400 (24h), Instagram's messaging window. A reply after 24h couldn't be answered with a normal DM anyway. The value must be a literal number (templates are only allowed in string fields).
- **Scheduling:** `waitOnTrigger` inserts the wait listener with `expires_at = now() + timeoutSeconds` and returns it. After the commit, the runner adds a job to `automation-wait-timeouts`, delayed until `expires_at`, with `jobId = timeout-<runId>-<sequence>`. A crash between the commit and the enqueue is covered: the step job's retry sees its step run `waiting`, reads `expires_at` back and re-adds the timeout job (the job id makes that a no-op if it already exists).
- **Matching respects the deadline:** `findListeners` skips wait listeners whose `expires_at` has passed. A reply that arrives after the deadline doesn't resume the run, even if the timeout job is late (worker backlog or downtime); it ends unmatched like any other event.
- **When the job fires** (`expireWait()`), in one transaction:
  1. claim the listener: `DELETE FROM automation_triggers ... WHERE run_id = $1 AND step_id = $2 AND expires_at <= now()`, joined to the step run at `sequence` with status `waiting`, `RETURNING id`. This is the first statement, as in `resumeRun`, so the two take their locks in the same order and can't deadlock. The join stops an old timeout job from expiring a later wait on the same step (a loop): that wait has a different sequence.
     - no row, and the listener exists but hasn't expired → the job fired early (Redis and Postgres clocks disagree): throw `WaitNotExpiredYetError`, and BullMQ retries in 1s, then 2s
     - no row otherwise → a reply or a cancellation won: do nothing
  2. lock the run; if it isn't `waiting`, do nothing
  3. mark the step run `succeeded` with outcome `timeout` and output `{ timedOut: true }`
  4. `advance()` with `next.timeout`: the run continues there (e.g. a "still interested?" DM), or, with no `next.timeout`, it's `completed`, the same as any outcome with no next step. No new run status is needed; the step run's `timeout` outcome shows why it ended.

  Then enqueue the next step, if any. A retry that finds nothing to claim but sees the step run's outcome is `timeout` and the run still `running` re-enqueues the run's current step (sequence `step_count + 1`), covering a crash between the commit and the enqueue.
- **Reply wins first:** `resumeRun` consumes the listener, and the timeout job later finds nothing to claim and no-ops. Leaving the delayed job in place is simpler than removing it, and harmless. Cancelling a run (pausing or deleting the automation) works the same way.
- **Validation:** `inputSchema` enforces the cap. Publish also rejects a `next.timeout` on a step without `timeoutSeconds`, since that branch could never be taken.
- **Visibility:** the runs API returns `waitExpiresAt` for a waiting run, and the dashboard shows "times out ..." on it.
- **Not built:** a periodic sweep for expired listeners whose delayed job was lost (e.g. Redis restarted without persistence). `expires_at` makes it a simple query; it belongs with the stuck-run sweep of edge cases #17 and #22.
- **Code:** `automation-wait-timeouts.{queue,worker}.ts` in `src/automations/`, registered in `src/workers.ts`; `waitOnTrigger()`, `waitExpiry()` and `expireWait()` in `runs.service.ts`; migration `004_wait_timeouts.sql`.

### Failure handling

All failure writes happen in the runner, so step implementations stay pure:

1. The runner catches the error and writes `status = failed`, `error` and `attempt` to the step run.
2. **Not the last attempt:** rethrow. BullMQ retries.
3. **Last attempt, or `UnrecoverableError`:** the general failure handler updates the run:
   - the step has `next.error` → continue there
   - otherwise → set the run to `failed`, copy the error, and delete its wait listener

   Then rethrow, so the BullMQ job also shows as failed.

The handler runs **inside the processor**, not from `worker.on("failed")`. The event handler only runs in memory, so if the process dies first the failure is never recorded, and it fires on every attempt, not just the last. `worker.on("failed")` is used for logging only.

## Example: the brief as data

```
key         step_type          config                                                              next
trigger     comment_received   { accountId: "acc_1", matchMode: "contains", keyword: "pricing" }  { ok: reply }
reply       reply_to_comment   { accountId: "{{trigger.accountId}}", commentId: "{{trigger.commentId}}",
                                 text: "Sent you a DM!" }                                          { ok: ask }
ask         send_dm            { accountId: "{{trigger.accountId}}", contactId: "{{trigger.contactId}}",
                                 text: "What's your email?" }                                      { ok: wait_email }
wait_email  message_received   { accountId: "{{trigger.accountId}}", contactId: "{{trigger.contactId}}",
                                 match: "email", timeoutSeconds: 82800 }                           { ok: send_link, timeout: remind }
send_link   send_dm            { accountId: "{{trigger.accountId}}", contactId: "{{trigger.contactId}}",
                                 text: "Here's your link: ..." }                                   {}
remind      send_dm            { accountId: "{{trigger.accountId}}", contactId: "{{trigger.contactId}}",
                                 text: "Still interested? ..." }                                   {}
```

Walkthrough:

1. `POST .../webhooks/comments` with "pricing" → event job matches the entry listener `account:acc_1` → a run is created and `reply` is enqueued.
2. Step jobs run `reply` (`commentOnPost`), then `ask` (`sendDm`).
3. `wait_email` registers a wait listener on `dm:acc_1:<contactId>`, and the run goes to `waiting`.
4. `POST .../webhooks/messages` with "hi" → `match: email` rejects it → no match → held as unmatched. The run keeps waiting.
5. `POST .../webhooks/messages` with "me@x.com" → the wait listener matches → the run resumes → `send_link` runs → the run is `completed`.
6. No email within 23h instead: the delayed timeout job ends the wait with outcome `timeout` → `remind` runs → the run is `completed`.

A version that wants to answer "that doesn't look like an email" can use `match: "any"`, followed by a `condition` step type (not needed for v1) whose `no_match` points back to an `ask_again` step.

## Design decisions

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Naming | `automation_steps` / `_runs` / `_step_runs` | "components", "flow", "executions": "flow" usually means the definition, not an instance. |
| Editing safety | Versioned rows, runs pin `version_id` | Mutable steps: reordering or deleting steps breaks runs that are mid-flow. A JSONB snapshot per run (n8n's approach) would also work, but loses relational queries on steps. |
| Graph shape | `next` jsonb map of outcome → step key on each step | Integer position: linear only. Separate edges table: an extra table for v1. `from_step_id` + `to_step_id[]`: one `from` can't express a step with several ways in (loops), and array indexes don't say which branch is which. |
| Triggers and waits | One `automation_triggers` table of listeners, used for both | Separate triggers and waits tables: two mechanisms for "an event continues a graph". |
| Platform specifics | Opaque `correlation_key` from step code; ids live in config and input | `social_account_id` / `contact_external_id` columns: tie the engine to one platform's shape. |
| Matching replies | The conversation's natural key, `accountId` + `contactId`, passed to `message_received` as input | Our trace id: the platform never sends it back in the contact's reply. A synthetic chat id: Instagram's message webhook has no thread id, so it would be invented on both sides and could drift apart. |
| Step names | Permanent `step_type` strings = folder names, mapped in one registry | Class names or file paths as ids: renaming code would break stored automations. |
| Step settings | `config` jsonb + zod `inputSchema` per step type in code | `input_structure`/`output_structure` per row: the schema is the same for every step of a type, so it belongs in code. |
| Unit of work | One BullMQ job per event and one per step | One job per run: a wait would hold a worker, and one failing step would retry the whole run, including messages already sent. Matching inside the webhook request: slow, and impossible to retry. |
| Reply-before-wait race | Unmatched events are held in a table; a run that starts waiting claims a matching one, both sides under a per-conversation advisory lock | Retrying the match with backoff (v1: 3 attempts, about 3s): any fixed window loses the reply when the steps queue is backed up or a worker crashes after sending the DM, and a longer window retries every non-matching comment too. Registering the listener in the same transaction as the previous step: shrinks the gap, but the DM still goes out before that commit. |
| Failure writes | A shared runner writes step-run and run status; the failure handler runs inside the processor | Each implementation writing its own DB status: duplicated and easy to get wrong. `worker.on("failed")` as the handler: in memory only, lost if the process dies, and fires on every attempt. |

## Edge cases

| # | Case | Handling | v1 |
|---|---|---|---|
| 1 | Duplicate webhook | Event `jobId` dedupes while the job exists; `UNIQUE (automation_id, trigger_event_id)` and the listener claim dedupe after that | Handled |
| 2 | Two replies at once for one waiting run | Listener claimed with `DELETE ... RETURNING`; whoever gets no row does nothing | Handled |
| 3 | Worker retries after the step's side effect succeeded | A succeeded step run for `(run_id, sequence)` is never re-executed; the retry only advances the run | Handled (a crash between the platform call and the DB write can still double-send; `idempotencyKey` is passed so a real client can dedupe) |
| 4 | Crash after commit, before the next step is enqueued | Step job: BullMQ retries it, and the runner sees the succeeded step run and re-enqueues the run's current step (next sequence = `step_count + 1`). Event job that started a run: the retry hits the duplicate-event constraint and re-enqueues that run's current step | Handled |
| 5 | Reply arrives before the wait listener exists | Held in `automation_unmatched_events`; the wait claims it and the run continues at once. The conversation lock means the two can't miss each other however long the gap ([Unmatched events](#unmatched-events)) | Handled |
| 6 | Message fits both a wait listener and an entry listener (user DMs "pricing" while we wait for their email) | Wait listeners win; no new run starts | Handled |
| 7 | Several runs waiting on the same contact | The oldest listener wins | Handled |
| 8 | Same person triggers the automation again while a run is active | Ignored, by `UNIQUE (automation_id, subject_key)` on active runs | Handled |
| 9 | Reply doesn't match (not an email) | `match()` returns null; the event is held (and later dropped) and the run keeps waiting | Handled |
| 10 | Our own comment replies and DM echoes come back as webhooks | Dropped in `webhooks.service.ts` before enqueueing | Handled |
| 11 | Infinite loop in the graph | `step_count` cap fails the run | Handled |
| 12 | Graph errors (missing entry trigger, unknown `step_type`, dangling `next` ids, unreachable steps, invalid config, a trigger in a position it doesn't support) | Validated when a version is published; drafts can be invalid | Handled |
| 13 | Step fails permanently | Runner marks the step run failed; the run follows `next.error` or is failed, and its listener is deleted | Handled |
| 14 | Run cancelled while a step job is queued | Runner does nothing when the run isn't `running` | Handled |
| 15 | Automation paused or deleted | Entry listeners deleted; waiting runs cancelled and their listeners deleted | Handled |
| 16 | New version published while runs are in progress | Entry listeners move to the new version; existing runs and wait listeners keep their pinned version | Handled |
| 17 | Failure handler itself fails (e.g. DB down on the last attempt) | The run stays `running` with no job | Limitation; later a sweep for runs `running` with no recent step activity |
| 18 | Contact never replies | Without `timeoutSeconds` the run waits indefinitely. With it, the listener gets `expires_at`, and a delayed job claims it and follows `next.timeout`, or completes the run ([Wait timeouts](#wait-timeouts)) | Handled when `timeoutSeconds` is set; a lost delayed job needs the sweep from #17 |
| 23 | Reply arrives after the deadline but before the timeout job runs | `findListeners` ignores expired listeners, so the reply doesn't match | Handled |
| 24 | Reply and timeout at the same moment | Both claim the listener with `DELETE ... RETURNING` first; only one gets the row | Handled |
| 25 | The contact DMs something before the question is asked (e.g. their email, unprompted) | Held, but a wait only claims events received after its previous step started | Handled |
| 19 | Platform messaging rules (e.g. Instagram allows one private reply to a comment and a limited window after the contact's last message) | Not enforced. `timeoutSeconds` is capped at 24h so a wait can't outlive Instagram's messaging window, but nothing forces an author to set it | Partly handled; verify against platform docs |
| 20 | Unsigned webhook requests | The dummy endpoints accept any caller | Limitation; real endpoints verify `X-Hub-Signature-256` |
| 21 | The commenter's `from.id` (comment webhook) differs from the DM `sender.id` for the same person | The wait listener would never match | Verify against platform docs; if they differ, map both ids to one contact |
| 22 | Crash after an event job resumes a run, before it enqueues the next step | The listener is already consumed, so the retry finds no match; the run stays `running` with no job | Limitation; covered by the same sweep as #17 |

## Implementation

Goal: the brief's flow working end to end. A signed-in user builds the "pricing" automation through the API or dashboard, publishes and activates it, fires the two simulated webhooks, and watches the run go `running → waiting → completed`.

### API

All `/api/automations` routes require a session (`{ auth: true }`) and only see the caller's own automations. Anyone else's automation returns the same `404` as a missing one. Inputs and responses are described with Elysia `t`, so `/openapi` stays accurate.

**Automations**

| Method & path | Does | Notes |
|---|---|---|
| `GET /api/automations` | List my automations | `id`, `name`, `active`, `publishedVersion` (number or null), `hasDraft`, `updatedAt`, plus run counts by status. Newest first; excludes deleted. |
| `POST /api/automations` | Create | Body `{ name }`. Creates the automation (`active: false`) and an empty draft, version 1. |
| `GET /api/automations/:id` | Get one | The automation, its draft steps (if any) and its published steps. |
| `PATCH /api/automations/:id` | Rename / turn on or off | Body `{ name?, active? }`. `active: true` requires a published version and creates the entry listener. `active: false` deletes it and cancels runs that are `running` or `waiting`. |
| `DELETE /api/automations/:id` | Soft delete | Sets `deleted_at`, then does the same cleanup as `active: false`. |
| `POST /api/automations/:id/publish` | Publish the draft | Validates the draft. On failure: `400` with every problem listed. On success, in one transaction: set `published_at` and `entry_step_id`, point `current_version_id` at the draft, and if the automation is active, swap the entry listener to the new version. |
| `DELETE /api/automations/:id/draft` | Discard the draft | Optional, but cheap. |

**Steps.** Steps are addressed by `key`. Every write goes to the draft. If there is no draft, the first write creates one by copying the published version (copy-on-write); keys are stable, so the copy needs no remapping.

| Method & path | Does | Notes |
|---|---|---|
| `GET /api/automations/:id/steps` | List steps | The draft's steps if there's a draft, otherwise the published version's. |
| `POST /api/automations/:id/steps` | Add a step | Body `{ key, stepType, label, config, next? }`. `409` on a duplicate key; `400` on an unknown `stepType`. |
| `PATCH /api/automations/:id/steps/:key` | Edit a step | Body `{ label?, config?, next? }`. The key can't change: templates and other steps' `next` refer to it. |
| `DELETE /api/automations/:id/steps/:key` | Remove a step | Other steps' `next` entries pointing at it are left in place; publish validation reports them. |

**Catalog and runs**

| Method & path | Does |
|---|---|
| `GET /api/automations/step-types` | The step catalog: `type`, `kind`, `outcomes`, and the input schema as JSON Schema (`z.toJSONSchema`). The dashboard builds its forms from this. |
| `GET /api/automations/:id/runs` | Runs for an automation: `status`, `subjectKey`, `currentStep`, `startedAt`, `finishedAt`, `error`. Newest first, paginated with `?limit=&before=`. |
| `GET /api/automations/:id/runs/:runId` | One run with its context and its step runs in sequence order. |

**Webhooks** (no session; see [Webhooks](#webhooks-simulated-instagram)): `POST /api/social-media/webhooks/comments`, `POST /api/social-media/webhooks/messages`. Both return `200 { received: <n events> }`.

### Validation at publish (`validation.ts`)

Drafts may be invalid while being edited; publish refuses unless every check passes, and returns all problems at once as `{ error, message, details: [{ stepKey?, problem }] }`:

1. There's at least one step, and exactly one entry trigger (`comment_received`). That step becomes `entry_step_id`.
2. Every `stepType` is in the registry.
3. Every `config` passes its step type's `inputSchema`. Templates are only allowed in string fields, so a templated value still passes as a string. Enum fields such as `matchMode` and `match` must be literal values.
4. Every `next` key is an outcome the step type can produce (plus `error`), and every target is an existing step key.
5. Every step can be reached from the entry step.
6. Trigger positions: `comment_received` only as the entry step, `message_received` never as the entry step.
7. Templates only reference `trigger.*` or `steps.<key>.*` for a key that exists in the version.

### Errors

Add `ValidationError` (`400`, `VALIDATION_ERROR`, with an optional `details` array) to `src/lib/errors.ts`, and extend `error-handling.ts` to include `details` in the response. A duplicate step key maps to the existing `ConflictError`.

### Dashboard (`public/dashboard.html`)

A single page with no build step, matching `index.html`:

- **My automations:** a list with status badges, a create form, and buttons to turn each one on or off and to delete it.
- **Editor:** for the selected automation, the steps table (key, type, label, next). Steps are added and edited with a form built from `/step-types`; `config` and `next` are JSON text areas in v1. There's a publish button that lists any validation problems.
- **Runs:** the selected automation's runs, auto-refreshing every 2s, with step runs shown on expand.
- **Simulator:** two small forms (account id, post id, contact id, text) that post Instagram-shaped bodies to the two webhooks. This makes the brief's walkthrough clickable.
- **Sample buttons:** "Send sample trigger" posts a comment built from the published entry trigger's config, from a new contact. On each waiting run, "Send sample reply" posts a DM using the input the waiting trigger is listening with (an email when `match: email`).

### Build order

Each phase ends with `bun test`, `bun run typecheck` and `bun run lint` passing.

| # | Phase | Files | Tests |
|---|---|---|---|
| 1 | Schema | `src/migrations/003_automations.sql` (all six tables, constraints and indexes from [Tables](#tables)) | migration applies on a fresh DB |
| 2 | Social media | `social-media.client.ts`, `webhooks.schema.ts`, `webhooks.service.ts`, `webhooks.route.ts` (registered in `src/index.ts`) | payload normalization; dropping our own events; one job enqueued per event |
| 3 | Steps | `steps/step.types.ts`, `steps/registry.ts`, the four `steps/<step_type>/` folders, `template.ts` | unit tests per step (`execute` with a fake client; `match` and `correlationKey`); template resolution, including missing paths |
| 4 | Automations API | `automations.schema.ts`, `automations.service.ts`, `validation.ts`, `automations.route.ts`, `ValidationError` | CRUD and ownership (`404` for others); copy-on-write drafts; each validation rule; publish and activate creating or removing entry listeners |
| 5 | Execution | `runs.service.ts`, `automation-events.{queue,worker}.ts`, `automation-steps.{queue,worker}.ts`, registered in `src/workers.ts` | processor tests with injected `enqueue` and client: happy path, retry skips a succeeded step, stale job, unrecoverable error, `next.error`, step cap; event job: wait beats entry, retry then unmatched, duplicate event |
| 6 | End to end | — | one integration test on isolated queues: create via API → publish → activate → comment webhook → run `waiting` → "hi" (still waiting) → email → `completed`, with `sendDm` called twice |
| 7 | Dashboard | `public/dashboard.html` | manual check in the browser (Playwright MCP is configured) |
| 8 | Seed and docs | `automations.seed.ts` ("pricing" automation for `alice`, published and active; deleted and re-created on every seed run); README section with the curl walkthrough; `CLAUDE.md` and this doc updated to say what's implemented | `bun run db:seed` twice leaves exactly one demo automation with one entry listener |

Test conventions follow the existing suites: integration tests hit the docker Postgres and Redis, skip when unreachable, use unique queue names per test file, and clean up the users they create (everything else cascades).

### What changed during implementation

- **Trigger interface:** gained `position`, `eventKeys` and `subjectKey`, so the event worker stays generic. It asks every trigger type for an event's keys instead of knowing key formats.
- **Duplicate events re-enqueue:** `startRun` returns the existing run for a duplicate event, so a retried event job can re-enqueue a step that was lost (edge case 4).
- **Constraints added:** at most one draft per automation, and at most one entry listener per automation (partial unique indexes).
- **Shared helpers:** `isUniqueViolation` moved to `src/db/db.ts` for reuse. `ValidationError` (`400`, with `details`) was added to `src/lib/errors.ts`.
- **Dashboard example:** the dashboard carries its own copy of the "pricing" example (`load the brief's example`), because the static UI has no build step to import `pricing-example.ts`.
- **Wait timeouts** (added after v1): `timeoutSeconds` on `message_received`, `automation_triggers.expires_at` (migration `004`), the `automation-wait-timeouts` queue and worker. The "pricing" example now waits 23h and then sends one reminder (`remind`). See [Wait timeouts](#wait-timeouts).
- **Unmatched events** (added after wait timeouts): the event job no longer retries a miss (`NoMatchYetError` is gone). It holds the event in `automation_unmatched_events` (migration `005`), and `waitOnTrigger()` claims it, both under a per-conversation advisory lock. See [Unmatched events](#unmatched-events).
- **Tests:** unit tests per step type, templates, validation and webhook normalization. Integration tests for the API (`automations.route.test.ts`), both processors driven with fake jobs (`execution.test.ts`), and the full HTTP → BullMQ → workers flow on isolated queues (`e2e.test.ts`).

### Open questions

- **Account ownership:** `accountId` in a trigger's config is free text, so any user could listen on any account id. Fine for the simulation; a real system would have a `social_accounts` table owned by users, and publish would check ownership.
