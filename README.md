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

- Test UI: http://localhost:3000
- API docs: http://localhost:3000/openapi
- Demo login: `alice`, `bob` or `carol` — password `Password123!`

Workers run inside the API process by default (`RUN_WORKERS_IN_PROCESS=true`); set it to `false` and use `bun run worker` to run them separately. Run tests with `bun test`.

Project structure, conventions and how background jobs (BullMQ) are organised are described in [CLAUDE.md](CLAUDE.md).

## Scripts

| script | what it does |
|---|---|
| `dev` / `start` | API server (`dev` with hot reload) |
| `worker` | standalone BullMQ worker process |
| `db:migrate` | apply `src/migrations/NNN_*.sql` in order |
| `db:seed` | run the idempotent seeds (demo users) |
| `db:reset` | drop schema, migrate, seed (refuses in production) |
| `test` / `typecheck` / `lint` | bun test · tsc · biome |

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
