import { type Job, Worker } from "bullmq";
import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import {
  AUTOMATION_STEPS_QUEUE,
  createStepEnqueuer,
  type EnqueueStep,
} from "./automation-steps.queue";
import {
  AUTOMATION_WAIT_TIMEOUTS_QUEUE,
  type WaitTimeoutJobData,
} from "./automation-wait-timeouts.queue";
import { expireWait, getRun, getStep, getStepRun } from "./runs.service";

export interface WaitTimeoutWorkerDeps {
  enqueueStep: EnqueueStep;
}

export type WaitTimeoutJobResult =
  | { status: "expired"; nextStepId: string | null }
  | { status: "skipped"; reason: string };

/** Thrown when the job fires before the listener's expires_at (clock skew); BullMQ retries. */
export class WaitNotExpiredYetError extends Error {
  constructor(runId: string, expiresAt: Date) {
    super(`Wait of run ${runId} expires at ${expiresAt.toISOString()}`);
    this.name = "WaitNotExpiredYetError";
  }
}

/**
 * Fires when a wait's timeout elapses: ends the wait with outcome `timeout` unless a reply
 * or a cancellation got there first. See docs/automation.md, "Wait timeouts".
 */
export async function processWaitTimeoutJob(
  job: Job<WaitTimeoutJobData>,
  deps: WaitTimeoutWorkerDeps,
): Promise<WaitTimeoutJobResult> {
  const { runId, stepId, sequence } = job.data;
  const log = {
    source: "automationWaitTimeoutsWorker",
    runId,
    stepId,
    sequence,
  };
  logger.info({
    event: "automation_wait_timeout_job_started",
    ...log,
    attempt: job.attemptsMade + 1,
  });

  const step = await getStep(stepId);
  const result = step ? await expireWait({ runId, step, sequence }) : null;
  if (!result) {
    // A previous attempt expired the wait but crashed before enqueueing the next step.
    // The run's next sequence is always stepCount + 1; the step job id dedupes.
    const [run, stepRun] = await Promise.all([
      getRun(runId),
      getStepRun(runId, sequence),
    ]);
    if (
      stepRun?.outcome === "timeout" &&
      run?.status === "running" &&
      run.currentStepId
    )
      await deps.enqueueStep({
        runId,
        stepId: run.currentStepId,
        sequence: run.stepCount + 1,
      });
    logger.info({ event: "automation_wait_timeout_job_skipped", ...log });
    return { status: "skipped", reason: "the run is no longer waiting here" };
  }
  if (result.status === "early")
    throw new WaitNotExpiredYetError(runId, result.expiresAt);

  if (result.nextStepId)
    await deps.enqueueStep({
      runId,
      stepId: result.nextStepId,
      sequence: sequence + 1,
    });
  logger.info({
    event: "automation_wait_timeout_job_completed",
    ...log,
    nextStepId: result.nextStepId,
  });
  return { status: "expired", nextStepId: result.nextStepId };
}

/** Queue names are overridable so tests run against isolated queues. */
export function startAutomationWaitTimeoutsWorker({
  queueName = AUTOMATION_WAIT_TIMEOUTS_QUEUE,
  stepsQueueName = AUTOMATION_STEPS_QUEUE,
}: {
  queueName?: string;
  stepsQueueName?: string;
} = {}) {
  const deps: WaitTimeoutWorkerDeps = {
    enqueueStep: createStepEnqueuer(stepsQueueName),
  };
  const worker = new Worker<WaitTimeoutJobData, WaitTimeoutJobResult>(
    queueName,
    (job) => processWaitTimeoutJob(job, deps),
    { connection: getRedisConnection(), concurrency: 10 },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    logger.error({
      event: "automation_wait_timeout_job_failed",
      source: "automationWaitTimeoutsWorker",
      jobId: job.id,
      runId: job.data.runId,
      attempt: job.attemptsMade,
      error: err.message,
    });
  });

  worker.on("error", (err) => {
    logger.error({
      event: "automation_wait_timeouts_worker_error",
      source: "automationWaitTimeoutsWorker",
      error: err.message,
    });
  });

  return worker;
}
