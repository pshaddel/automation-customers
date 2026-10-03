import { type Job, Worker } from "bullmq";
import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import { EXAMPLE_QUEUE, type ExampleJobData } from "./example.queue";

const SIMULATED_STEPS = 3;
const STEP_MS = 50;

export async function processExampleJob(
  job: Job<ExampleJobData>,
): Promise<void> {
  logger.info({
    event: "example_job_started",
    source: "exampleWorker",
    jobId: job.id,
    userId: job.data.userId,
    attempt: job.attemptsMade + 1,
  });

  for (let step = 1; step <= SIMULATED_STEPS; step++) {
    await Bun.sleep(STEP_MS);
    await job.updateProgress(Math.round((step / SIMULATED_STEPS) * 100));
  }

  logger.info({
    event: "example_job_completed",
    source: "exampleWorker",
    jobId: job.id,
  });
}

/** `queueName` is overridable so tests can run against an isolated queue. */
export function startExampleWorker({
  queueName = EXAMPLE_QUEUE,
}: {
  queueName?: string;
} = {}) {
  const worker = new Worker<ExampleJobData, void>(
    queueName,
    processExampleJob,
    {
      connection: getRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    logger.error({
      event: "example_job_failed",
      source: "exampleWorker",
      jobId: job.id,
      attempt: job.attemptsMade,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  worker.on("error", (err) => {
    logger.error({
      event: "example_worker_error",
      source: "exampleWorker",
      error: err.message,
    });
  });

  return worker;
}
