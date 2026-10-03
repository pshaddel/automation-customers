import { SQL } from "bun";
import { logger } from "../lib/logger";

export type Database = InstanceType<typeof SQL>;

let sql: Database | undefined;

export function initDb(url: string): Database {
  sql = new SQL({ url, idleTimeout: 20, max: 10 });
  return sql;
}

export function getDb(): Database {
  if (!sql) throw new Error("Database not initialized. Call initDb() first.");
  return sql;
}

export async function closeDb(): Promise<void> {
  await sql?.close({ timeout: 5 });
  sql = undefined;
}

export async function testDbConnectionOnStartup(): Promise<void> {
  try {
    await getDb()`SELECT 1`;
    logger.info({ event: "db_connected", source: "db" });
  } catch (error) {
    logger.error({
      event: "db_connection_failed",
      source: "db",
      error: String(error),
    });
    process.exit(1);
  }
}

export async function dbHealthCheck(): Promise<boolean> {
  try {
    await getDb()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
