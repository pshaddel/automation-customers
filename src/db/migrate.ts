/**
 * Forward-only SQL migration runner.
 *
 * - Migrations live in `src/migrations/NNN_snake_case.sql` and are applied in
 *   filename order. Applied names are recorded in `_migrations`.
 * - Each file runs in its own transaction together with its `_migrations`
 *   insert, so a failing file rolls back completely.
 * - Concurrency: every transaction first takes a transaction-scoped Postgres
 *   advisory lock (`pg_advisory_xact_lock`) and re-checks `_migrations` under
 *   it, so concurrent migrators (e.g. several instances booting at once)
 *   serialise and never apply a file twice. Transaction-scoped locks are tied
 *   to the pooled connection running the tx and are released automatically on
 *   COMMIT/ROLLBACK, so they are safe with pooling and can never leak.
 *   (A session lock on `db.reserve()` + `reserved.begin()` was avoided: in Bun
 *   1.3 a failed `begin()` on a reserved connection also emits an unhandled
 *   rejection.)
 */
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { logger } from "../lib/logger";
import { closeDb, type Database, getDb, initDb } from "./db";

export const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");

/** Arbitrary constant key for pg_advisory_lock ("automig" in hex-ish). */
const MIGRATION_LOCK_KEY = 727_465_001;

export async function listMigrationFiles(
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("*.sql").scan({ cwd: dir, onlyFiles: true }),
  );
  return files.sort();
}

export async function runMigrations(
  db: Database = getDb(),
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  const applied: string[] = [];

  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await tx`
      CREATE TABLE IF NOT EXISTS _migrations (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  });

  for (const file of files) {
    const content = await Bun.file(join(dir, file)).text();
    const ran = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      // Checked under the lock so a concurrent migrator's work is visible.
      const [existing] =
        await tx`SELECT 1 FROM _migrations WHERE name = ${file}`;
      if (existing) return false;
      await tx.unsafe(content);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      return true;
    });
    if (ran) {
      applied.push(file);
      logger.info({
        event: "migration_applied",
        source: "migrate",
        name: file,
      });
    }
  }

  if (applied.length === 0) {
    logger.info({
      event: "migrations_up_to_date",
      source: "migrate",
      total: files.length,
    });
  }
  return applied;
}

if (import.meta.main) {
  try {
    const config = loadConfig();
    initDb(config.DATABASE_URL);
    await runMigrations();
    await closeDb();
  } catch (error) {
    logger.error({
      event: "migration_failed",
      source: "migrate",
      error: String(error),
    });
    await closeDb().catch(() => {});
    process.exit(1);
  }
}
