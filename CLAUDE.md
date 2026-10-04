# CLAUDE.md

Backend for comment-triggered social automations (take-home brief: `docs/CHALLENGE.md`; design, data model and reasoning: `docs/automation.md`).
Bun + Elysia · Postgres 18 via Bun's native `SQL` (no ORM) · BullMQ + Redis 8 · hand-rolled username/password auth.

## Commands

```sh
docker compose up -d        # postgres :5491, redis :6391
bun run dev                 # API + in-process workers, http://localhost:3000 (UI), /openapi (docs)
bun run worker              # standalone worker process
bun run db:migrate | db:seed | db:reset
bun test                    # integration tests hit the docker postgres/redis; suites skip if unreachable
bun run typecheck && bun run lint
```

Run `bun test`, `bun run typecheck` and `bun run lint` before considering work done.

## Project structure

Code is organised **by domain**, never by technical layer. **Do not** create global `workers/`, `queues/`, `modules/`, `services/` or `routes/` folders.

```
src/
  index.ts            API entry: config → db → migrations → redis → (workers) → Elysia app
  worker.ts           standalone worker entry (same boot, no HTTP)
  workers.ts          worker registry only: starts each domain's start*Worker(), closeAll()
  config/             zod env schema (env.ts) + loadConfig()/getConfig()
  db/                 db.ts (initDb/getDb), migrate.ts, seed.ts, reset.ts
  migrations/         NNN_snake_case.sql (forward-only)
  lib/                shared infra: logger (pino), errors, error-handling, redis, queue
  <domain>/           <domain>.route.ts · .service.ts · .queue.ts · .worker.ts · .seed.ts · .schema.ts · __tests__/
    auth/  users/  health/  example/
    automations/      engine + API: automation-events.{queue,worker}, automation-steps.{queue,worker} (step runner),
                      automation-wait-timeouts.{queue,worker} (delayed job per wait with timeoutSeconds),
                      automations.{route,service,schema,seed}, runs.service, validation, template,
                      steps/<step_type>/ (one folder per step implementation) + steps/registry.ts
    social-media/     simulated Instagram webhooks (webhooks.{route,service,schema}) and the dummy client (sendDm, commentOnPost)
public/               static test UI, no build step: index.html (sign in / sign up), dashboard.html (automations, runs, webhook simulator)
```

Conventions:
- **Routes:** a factory `export function usersModule() { return new Elysia({ prefix, detail: { tags } }) ... }`, registered in `src/index.ts`. Validate inputs and describe responses with Elysia `t` so OpenAPI stays accurate.
- **Services:** plain async functions. They get the DB through `getDb()` (or an optional `db` parameter so seeds and transactions can pass one in).
- **SQL:** Bun tagged templates, `const [row] = await getDb()<Row[]>\`SELECT ... WHERE id = ${id}\``. Map snake_case rows to camelCase at the service boundary. Use `getDb().begin(async (tx) => ...)` for multi-statement writes. Don't call `.begin()` on a `db.reserve()` connection: in Bun 1.3 failures surface as unhandled rejections.
- **Errors:** throw `AppError` subclasses from `src/lib/errors.ts`. `src/lib/error-handling.ts` maps them to `{ error, message }` + status. `ValidationError` (400) also carries `details: [{ stepKey?, problem }]`, returned as-is. Map Postgres unique violations with `isUniqueViolation()` from `src/db/db.ts`.
- **Logging:** structured, `logger.info({ event: "snake_case_event", source: "<component>", ...ids })`.
- **Auth:** add `{ auth: true }` to a route to require a session. The handler then receives a typed `user` (`src/auth/auth.plugin.ts`).
- **Migrations:** new `src/migrations/NNN_*.sql` file, never edit an applied one. Each file runs in one transaction, so no `CREATE INDEX CONCURRENTLY`. Tables get `created_at`/`updated_at` (with the `set_updated_at()` trigger from `001_init.sql`) and soft-delete via `deleted_at`.
- **Seeds:** `src/<domain>/<domain>.seed.ts` exporting `order: number` and `run(db)`. Seeds must be idempotent: running them again leaves the same end state. Skipping existing rows (users) or deleting and re-creating demo data are both fine. `automations.seed.ts` hard-deletes alice's demo automation (its runs and listeners cascade) and re-creates it from `pricing-example.ts`. `public/dashboard.html` has its own copy of that example, so keep the two in sync.

## Async tasks (BullMQ)

Shared pieces (`src/lib`):
- **`redis.ts`:** one lazy ioredis connection (`maxRetriesPerRequest: null`, required by BullMQ workers), shared by all queues and workers. The startup ping and health ping have timeouts.
- **`queue.ts`:** `createQueue<TData, TResult>(name)` creates or reuses a typed queue with `DEFAULT_JOB_OPTIONS`:
  - 3 attempts with exponential backoff, starting at 1s
  - completed jobs kept for 1h (max 1000) so their status can be polled
  - failed jobs kept for 7 days

  `closeQueues()` closes every queue on shutdown.

Each domain owns its queue and worker. To add background work (e.g. `file-handling`):
1. **`src/file-handling/file-handling.queue.ts`:**
   - queue name constant
   - typed `JobData` interface
   - `getFileHandlingQueue()` via `createQueue`
   - `enqueueX(data, jobId?)` helper. Pass a deterministic `jobId` (e.g. derived from the triggering event id) to make enqueues idempotent: BullMQ ignores a duplicate `jobId` while the job still exists.
2. **`src/file-handling/file-handling.worker.ts`:** `startFileHandlingWorker()` (see `src/example/example.worker.ts`):
   - `new Worker<Data, Result>(QUEUE, processor, { connection: getRedisConnection(), concurrency })`
   - log `*_job_started` / `*_job_completed` from the processor
   - attach `worker.on("failed")` and `worker.on("error")` handlers that log
   - export the processor separately so it can be unit-tested
   - accept a `queueName` override so tests run against an isolated queue
3. **Register it** in `src/workers.ts`: start it in `startWorkers()` and close it in `closeAll()`.
4. **Enqueue from a route or service.** Never do slow or external work inline in a request handler.

Job processors must be **idempotent and retry-safe**: a job may run more than once because of retries or stalled-job recovery. Throw to trigger a retry, and keep side effects guarded by DB state.

Workers run inside the API process when `RUN_WORKERS_IN_PROCESS=true` (dev default). In production, set it to `false` and run `bun run worker` as its own process, so you can scale it independently. Both entrypoints shut down gracefully on SIGTERM/SIGINT: workers first, then queues, Redis, and the DB.

Sample flow: `POST /api/example/jobs` enqueues a job, `GET /api/example/jobs/:id` returns its state and progress (the UI polls this), and `src/example/example.worker.ts` processes it.

## Automations

Full design, edge cases and reasoning: `docs/automation.md`. Keep it in sync when the engine changes.

Step types:
- `step_type` values (`comment_received`, `reply_to_comment`, `send_dm`, `message_received`) are stored in the database: **never rename one**. Each matches its folder under `src/automations/steps/` and is mapped only in `steps/registry.ts`.
- To add a step type: a new `steps/<step_type>/<step_type>.step.ts` implementing `ActionStep` or `TriggerStep` (`steps/step.types.ts`), register it, add unit tests in its `__tests__/`. Implementations stay pure (input → output or throw); the step runner (`automation-steps.worker.ts`) owns every DB write, retry and failure decision.
- An incompatible change to a step is a new type (e.g. `send_dm_v2`), so published versions keep working.

Engine invariants (`runs.service.ts`, the two workers):
- Every run state transition locks the run row (`SELECT ... FOR UPDATE`) inside `getDb().begin()`, so a resume, a step completion and a cancellation can't interleave.
- A run's next step sequence is always `step_count + 1`. Step job ids are `<runId>-<sequence>`, event job ids `<eventType>-<eventId>`, wait-timeout job ids `timeout-<runId>-<sequence>`.
- `automation_triggers` holds listeners: `run_id IS NULL` = entry listener (one per active automation, on its current version, kept in sync by `syncEntryListener`); `run_id` set = wait listener, claimed with `DELETE ... RETURNING` when matched.
- `next` maps outcome → step **key** (keys are stable across versions). Published versions are immutable; edits go to the draft (copy-on-write).
- Wait listeners match against the waiting step run's resolved `input`; entry trigger config can't contain templates.
- **Wait timeouts:** a wait trigger opts in with `TriggerStep.timeoutSeconds(input)` (`message_received`: config `timeoutSeconds`, max 24h) and lists `timeout` in its outcomes. `automation_triggers.expires_at` is the source of truth (`findListeners` ignores expired listeners); the delayed job on `automation-wait-timeouts` only wakes the run up. `expireWait()` claims the listener with `DELETE ... RETURNING` before locking the run, the same order as `resumeRun`, then follows `next.timeout` or completes the run. Keep that lock order in any new code that claims listeners.
- Tests: processors (including `processWaitTimeoutJob`; simulate an elapsed timeout by moving `expires_at` into the past) are driven with `fakeJob()` / `fakeSocialMedia()` from `src/automations/__tests__/helpers.ts`; `e2e.test.ts` runs HTTP → BullMQ → workers on queue names unique to the file.

## Environment notes

- Env vars are validated in `src/config/env.ts`. Add new ones there and to `.env.example`. Bun auto-loads `.env`.
- Pinned versions: `bullmq` 6.x, `ioredis` 6.x (`import { Redis } from "ioredis"`), `zod` 4, `elysia` 1.4, TypeScript 7.

Gotchas:
- **Bun SQL + jsonb:** pass objects directly (`${obj}::jsonb`). `JSON.stringify` double-encodes them into a JSON string. A `null` parameter cast to `::jsonb` is SQL `NULL`; wrap it in `COALESCE(..., 'null'::jsonb)` where that matters (e.g. inside `jsonb_set`).
- **Bun SQL + lists:** use `col IN ${db(list)}` with a non-empty list. `= ANY(${array})` fails (malformed array literal), and `sql.array()` gave wrong results.
- **BullMQ custom job ids** can't contain `:` (it throws). Queue names can't either.
- **`bun run dev` (`--hot`) and `public/`:** after editing a static file, the running server keeps sending it with the old size, truncating the page (a script cut short fails silently). Restart the server after changing `public/`. Each hot reload also starts another set of in-process workers without closing the old ones.
- **`ls`** may be aliased to `eza` in the user's shell and hang; use `find` or `/bin/ls`.
