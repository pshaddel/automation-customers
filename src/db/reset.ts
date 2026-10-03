/**
 * DESTRUCTIVE: drops the `public` schema, then re-runs migrations and seeds.
 * Refuses to run when NODE_ENV=production.
 */
import { loadConfig } from "../config/config";
import { logger } from "../lib/logger";
import { closeDb, initDb } from "./db";
import { runMigrations } from "./migrate";
import { runSeeds } from "./seed";

if (import.meta.main) {
  try {
    const config = loadConfig();
    if (config.NODE_ENV === "production") {
      logger.error({
        event: "db_reset_refused",
        source: "reset",
        reason: "NODE_ENV=production",
      });
      process.exit(1);
    }
    const db = initDb(config.DATABASE_URL);
    await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    logger.info({ event: "db_schema_dropped", source: "reset" });
    await runMigrations(db);
    await runSeeds(db);
    await closeDb();
    logger.info({ event: "db_reset_complete", source: "reset" });
  } catch (error) {
    logger.error({
      event: "db_reset_failed",
      source: "reset",
      error: String(error),
    });
    await closeDb().catch(() => {});
    process.exit(1);
  }
}
