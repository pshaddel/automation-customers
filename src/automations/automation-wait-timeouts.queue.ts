import { createQueue } from "../lib/queue";

export const AUTOMATION_WAIT_TIMEOUTS_QUEUE = "automation-wait-timeouts";

export interface WaitTimeoutJobData {
  runId: string;
  /** The waiting trigger step. */
  stepId: string;
  /** The waiting step run's sequence; a later wait on the same step (a loop) has another. */
  sequence: number;
}

export type EnqueueWaitTimeout = (
  data: WaitTimeoutJobData,
  expiresAt: Date,
) => Promise<void>;

export function getAutomationWaitTimeoutsQueue(
  queueName: string = AUTOMATION_WAIT_TIMEOUTS_QUEUE,
) {
  return createQueue<WaitTimeoutJobData>(queueName);
}

/** Delayed until `expiresAt`. Idempotent: `timeout-<runId>-<sequence>` identifies one wait. */
export function createWaitTimeoutEnqueuer(
  queueName: string = AUTOMATION_WAIT_TIMEOUTS_QUEUE,
): EnqueueWaitTimeout {
  return async (data, expiresAt) => {
    await getAutomationWaitTimeoutsQueue(queueName).add("timeout", data, {
      jobId: `timeout-${data.runId}-${data.sequence}`,
      delay: Math.max(0, expiresAt.getTime() - Date.now()),
    });
  };
}
