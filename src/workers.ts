/**
 * Worker registry. Each domain's `start*Worker` (e.g. src/example/example.worker.ts)
 * is registered here; `closeAll` shuts down workers, then queues, then Redis.
 */
import { startAutomationEventsWorker } from "./automations/automation-events.worker";
import { startAutomationStepsWorker } from "./automations/automation-steps.worker";
import { startAutomationWaitTimeoutsWorker } from "./automations/automation-wait-timeouts.worker";
import { startExampleWorker } from "./example/example.worker";
import { logger } from "./lib/logger";
import { closeQueues } from "./lib/queue";
import { closeRedis } from "./lib/redis";

export function startWorkers() {
  const exampleWorker = startExampleWorker();
  const automationEventsWorker = startAutomationEventsWorker();
  const automationStepsWorker = startAutomationStepsWorker();
  const automationWaitTimeoutsWorker = startAutomationWaitTimeoutsWorker();

  logger.info({
    event: "workers_started",
    source: "workers",
    workers: [
      "example",
      "automation-events",
      "automation-steps",
      "automation-wait-timeouts",
    ],
  });

  return {
    exampleWorker,
    automationEventsWorker,
    automationStepsWorker,
    automationWaitTimeoutsWorker,
    closeAll: async () => {
      await Promise.all([
        exampleWorker.close(),
        automationEventsWorker.close(),
        automationStepsWorker.close(),
        automationWaitTimeoutsWorker.close(),
      ]);
      await closeQueues();
      await closeRedis();
      logger.info({ event: "workers_stopped", source: "workers" });
    },
  };
}
