/**
 * Worker registry. Each domain's `start*Worker` (e.g. src/example/example.worker.ts)
 * is registered here; `closeAll` shuts down workers, then queues, then Redis.
 */
import { startExampleWorker } from "./example/example.worker";
import { logger } from "./lib/logger";
import { closeQueues } from "./lib/queue";
import { closeRedis } from "./lib/redis";

export function startWorkers() {
  const exampleWorker = startExampleWorker();

  logger.info({
    event: "workers_started",
    source: "workers",
    workers: ["example"],
  });

  return {
    exampleWorker,
    closeAll: async () => {
      await exampleWorker.close();
      await closeQueues();
      await closeRedis();
      logger.info({ event: "workers_stopped", source: "workers" });
    },
  };
}
