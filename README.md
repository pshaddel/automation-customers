# automation-customers

Backend for comment-triggered social automations (see [docs/CHALLENGE.md](docs/CHALLENGE.md)).

**Stack:** Bun · Elysia · Postgres 18 (Bun native `SQL`, no ORM) · BullMQ + Redis 8 · hand-rolled username/password auth.

## Quickstart

```sh
cp .env.example .env
docker compose up -d          # postgres :5491, redis :6391
bun install
bun run db:migrate
bun run db:seed               # alice / bob / carol — password: Password123!
bun run dev                   # http://localhost:3000  (test UI)  ·  /openapi (API docs)
```

## Scripts

| script | what it does |
|---|---|
| `dev` / `start` | API server (also runs pending migrations on boot; runs workers in-process when `RUN_WORKERS_IN_PROCESS=true`) |
| `worker` | standalone worker process |
| `db:migrate` | applies `src/migrations/NNN_*.sql` in order, each in a transaction, guarded by an advisory lock |
| `db:seed` | runs every `src/**/*.seed.ts` (by exported `order`); seeds are idempotent |
| `db:reset` | drop schema → migrate → seed (refuses in production) |
| `test` / `typecheck` / `lint` | bun test · tsc · biome |

## Layout

Code is organised by **domain**. Each domain folder owns its route, service, queue, worker and seed:

```
src/
  index.ts  worker.ts  workers.ts      # entrypoints + worker registry
  config/  db/  lib/  migrations/      # shared infrastructure
  auth/     auth.{route,service,plugin}.ts
  users/    users.{route,service,schema,seed}.ts
  health/   health.route.ts
  example/  example.{route,queue,worker}.ts   # sample BullMQ queue + worker
public/index.html                       # test UI
```

To add a domain with background work (e.g. `file-handling`): create
`src/file-handling/file-handling.{queue,worker,route}.ts` with `createQueue()` from `src/lib/queue.ts`, then register its `start*Worker()` in `src/workers.ts`.

## Auth

- `POST /api/auth/sign-up`, `/sign-in`, `/sign-out`
- Passwords: argon2id via `Bun.password`
- Sessions: a random token in an httpOnly `sid` cookie. Only its sha256 is stored in `sessions`.
- Protected routes use `{ auth: true }` (macro in `src/auth/auth.plugin.ts`), which resolves `user`.
- Users are soft-deleted (`deleted_at`). Soft-deleting a user revokes their sessions.
