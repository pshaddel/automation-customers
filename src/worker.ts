/** Standalone worker process entry (`bun run worker`). */
import { loadConfig } from "./config/config";
import { closeDb, initDb, testDbConnectionOnStartup } from "./db/db";
import { logger } from "./lib/logger";
import { testRedisConnectionOnStartup } from "./lib/redis";
import { startWorkers } from "./workers";

const config = loadConfig();

initDb(config.DATABASE_URL);
await testDbConnectionOnStartup();
await testRedisConnectionOnStartup();

const workers = startWorkers();
logger.info({ event: "worker_process_started", source: "worker" });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "worker_process_shutdown", source: "worker", signal });
  try {
    await workers.closeAll();
    await closeDb();
  } catch (error) {
    logger.error({
      event: "worker_process_shutdown_failed",
      source: "worker",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
