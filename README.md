# automation-customers

Bun + Elysia backend for comment-triggered social automations — see [docs/CHALLENGE.md](docs/CHALLENGE.md).

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

Project structure, conventions and how background jobs (BullMQ) are organised are described in [CLAUDE.md](CLAUDE.md).

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

Design, data model, execution model, edge cases and the reasoning behind each decision: [docs/automation.md](docs/automation.md).

In short: an automation is a versioned graph of steps (`comment_received` → `reply_to_comment` → `send_dm` → `message_received` → `send_dm`). Webhooks enqueue one BullMQ job per event; the event worker matches it to listeners (entry triggers start runs, wait triggers resume them); the step worker runs one job per step. Code lives in `src/automations/` (engine, API, step implementations under `steps/<step_type>/`) and `src/social-media/` (simulated webhooks and the dummy `sendDm` / `commentOnPost`).

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

The dummy platform calls are logged (`social_media_comment_reply_sent`, `social_media_dm_sent`), and the run with its step-by-step history shows up in the dashboard and at `GET /api/automations/:id/runs`. Event ids must be unique: re-sending the same `comment_1` is treated as a duplicate webhook.

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
