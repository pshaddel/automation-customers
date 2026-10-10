# Running and using the project

How to run, try and call the automation backend. The design (architecture, data model, execution model) is in the [README](../README.md); every edge case and design decision is in [automation.md](automation.md).

New to the code? The [Automation Engine Field Guide](https://claude.ai/artifact/1xNMEhi1hTDYj2wpHi6uUM) walks through the architecture, every table and how they relate, and a run stage by stage, then ends with a quiz on the source code.

## Quick Start

Requirements: [Bun](https://bun.sh) ≥ 1.3, Docker with Compose.

```sh
cp .env.example .env
docker compose up -d      # Postgres 18 on :5491, Redis 8 on :6391
bun install
bun run db:migrate
bun run db:seed
bun run dev
```

- Test UI: http://localhost:3000 (sign in), then the **Dashboard** to build automations, watch runs and simulate Instagram
- API docs: http://localhost:3000/openapi
- Demo login: `alice`, `bob` or `carol` — password `Password123!`. The seed gives `alice` the brief's automation ("Pricing DM (demo)", account `acc_demo`), published and on; every `db:seed` deletes and re-creates it, runs included. In the dashboard, **Send sample trigger** fires a matching comment from a new contact, and **Send sample reply** on a waiting run answers with an email, which tests the whole flow in two clicks.

Workers run inside the API process by default (`RUN_WORKERS_IN_PROCESS=true`); set it to `false` and use `bun run worker` to run them separately. Run tests with `bun test`.

Project structure, conventions and how background jobs (BullMQ) are organised are described in [CLAUDE.md](../CLAUDE.md).

## Scripts

| script | what it does |
|---|---|
| `dev` / `start` | API server (`dev` with hot reload) |
| `worker` | standalone BullMQ worker process |
| `db:migrate` | apply `src/migrations/NNN_*.sql` in order |
| `db:seed` | run the seeds: demo users (skipped if present), alice's demo automation (re-created) |
| `db:reset` | drop schema, migrate, seed (refuses in production) |
| `test` / `typecheck` / `lint` | bun test · tsc · biome |

## Automations

Every edge case and the reasoning behind each decision: [docs/automation.md](automation.md). Code lives in `src/automations/` (engine, API, step implementations under `steps/<step_type>/`) and `src/social-media/` (simulated webhooks and the dummy `sendDm` / `commentOnPost`).

### Try the brief's flow with curl

After `bun run db:seed` and `bun run dev`, alice's demo automation listens on account `acc_demo`:

```sh
# Someone comments "pricing" → we reply, DM them for their email, and wait
curl -s localhost:3000/api/social-media/webhooks/comments -H 'content-type: application/json' -d '{
  "object": "instagram",
  "entry": [{ "id": "acc_demo", "time": 0, "changes": [{ "field": "comments",
    "value": { "id": "comment_1", "text": "What is the pricing?", "from": { "id": "contact_1" }, "media": { "id": "post_1" } } }] }]
}'

# They reply with an email → we DM them the link and the run completes
curl -s localhost:3000/api/social-media/webhooks/messages -H 'content-type: application/json' -d '{
  "object": "instagram",
  "entry": [{ "id": "acc_demo", "time": 0, "messaging": [{ "sender": { "id": "contact_1" }, "recipient": { "id": "acc_demo" },
    "timestamp": 0, "message": { "mid": "mid_1", "text": "sure: me@example.com" } }] }]
}'
```

If they never reply, the demo's wait times out after 23h (`timeoutSeconds: 82800` on `wait_email`, see below): the run sends one reminder DM and completes.

The dummy platform calls are logged (`social_media_comment_reply_sent`, `social_media_dm_sent`), and the run with its step-by-step history shows up in the dashboard and at `GET /api/automations/:id/runs`. Event ids must be unique: re-sending the same `comment_1` is treated as a duplicate webhook.

### Wait timeouts

A `message_received` step can stop waiting after `timeoutSeconds` (1 to 86400, so at most Instagram's 24h messaging window). It then finishes with outcome `timeout` and the run follows `next.timeout`, or completes if there is none. Without `timeoutSeconds` the run waits indefinitely.

```json
{ "key": "wait_email", "stepType": "message_received",
  "config": { "accountId": "{{trigger.accountId}}", "contactId": "{{trigger.contactId}}", "match": "email", "timeoutSeconds": 82800 },
  "next": { "ok": "send_link", "timeout": "remind" } }
```

How it works:
- **Deadline in Postgres:** the wait listener stores `expires_at` (`automation_triggers`). Matching ignores expired listeners, so a reply after the deadline never resumes the run, even if the timeout job runs late.
- **Delayed job:** the step runner schedules one delayed BullMQ job per wait, on the `automation-wait-timeouts` queue, with id `timeout-<runId>-<sequence>`. When it fires, it claims the listener with `DELETE ... RETURNING`, the same way a reply does, so exactly one of them moves the run on. If a reply got there first, the job does nothing.
- **Visibility:** waiting runs expose `waitExpiresAt` in the runs API, and the dashboard shows when they time out.

Details and edge cases: [docs/automation.md → Wait timeouts](automation.md#wait-timeouts).

### API

All `/api/automations` routes need a session and only see the caller's own automations (others' look like `404`). Full schemas: `/openapi`.

| Method & path | Does |
|---|---|
| `GET /api/automations` | list my automations, with run counts |
| `POST /api/automations` | create (inactive, with an empty draft) |
| `GET /api/automations/:id` | one automation with its draft and published steps |
| `PATCH /api/automations/:id` | rename, or turn on/off (`{ name?, active? }`); off cancels its running and waiting runs |
| `DELETE /api/automations/:id` | soft delete; cancels its runs |
| `POST /api/automations/:id/publish` | validate the draft and make it live; `400` lists every problem |
| `DELETE /api/automations/:id/draft` | discard unpublished changes |
| `GET /api/automations/:id/steps` | steps of the draft, or of the published version |
| `POST /api/automations/:id/steps` | add a step (`{ key, stepType, label, config, next }`) |
| `PATCH /api/automations/:id/steps/:key` | edit a step's `label`, `config` or `next` |
| `DELETE /api/automations/:id/steps/:key` | remove a step |
| `GET /api/automations/step-types` | step catalog with JSON Schemas for each config |
| `GET /api/automations/:id/runs` | runs, newest first (`?limit=&before=`) |
| `GET /api/automations/:id/runs/:runId` | one run with its context and step runs |
| `POST /api/social-media/webhooks/comments` | simulated Instagram comment webhook (no auth) |
| `POST /api/social-media/webhooks/messages` | simulated Instagram messaging webhook (no auth) |

### Limitations

The full list, with how each case is handled, is the edge-case table in [docs/automation.md](automation.md#edge-cases). The main ones:

- **Timeouts are opt-in:** a wait without `timeoutSeconds` still waits forever.
- **No stuck-run sweep:** if the process dies at the wrong moment (the failure handler itself failing, or a crash right after a reply resumes a run), a run can stay `running` with no job behind it. The same applies to a wait whose delayed timeout job is lost (e.g. Redis restarts without persistence): no reply can resume it after `expires_at`, but nothing moves it on. Planned: a periodic sweep.
- **Webhooks aren't verified:** the simulated endpoints accept any caller; real ones must check `X-Hub-Signature-256`.
- **Account ownership isn't checked:** a trigger's `accountId` is free text, so any user can listen on any account id. A real system needs a `social_accounts` table.
- **Platform rules aren't enforced,** e.g. Instagram's messaging window after the contact's last message. Wait timeouts are capped at 24h, but nothing forces an author to set one.

### Development note

After editing files in `public/`, restart `bun run dev`. The hot-reloading server keeps sending static files with their old size, so an edited page arrives cut off and its script silently fails (for example, an empty automation list).

## Authentication

- **Endpoints:** `POST /api/auth/sign-up`, `POST /api/auth/sign-in`, `POST /api/auth/sign-out`.
- **Passwords** are hashed with argon2id via `Bun.password`.
- **Sessions:** on sign-up or sign-in a random 32-byte token is sent in an httpOnly `sid` cookie. Only its sha256 hash is stored in the `sessions` table, so a database leak does not expose usable tokens. Sessions expire after 30 days; sign-out deletes the session and clears the cookie.
- **Protected routes** opt in with the `{ auth: true }` Elysia macro (`src/auth/auth.plugin.ts`). On every request it looks up the session and its user in Postgres and exposes `user` to the handler, or responds `401`.
- **Soft-deleted users** (`deleted_at` set) cannot sign in, and deleting a user revokes all of their sessions.

### Limitations

- Auth was not the focus of this task, so we chose a simple username/password authentication.
- Performance: every authenticated request checks the database for the session, which is not ideal. A cache (e.g. Redis) or stateless signed tokens would avoid that round-trip.
- It is not protected against brute-force attacks: there is no rate limiting, account lockout or captcha on sign-in.
