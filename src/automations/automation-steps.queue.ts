import { createQueue } from "../lib/queue";

export const AUTOMATION_STEPS_QUEUE = "automation-steps";

export interface StepJobData {
  runId: string;
  stepId: string;
  /** Position of this step in the run; part of the job id so each execution is unique. */
  sequence: number;
}

export type EnqueueStep = (data: StepJobData) => Promise<void>;

export function getAutomationStepsQueue(
  queueName: string = AUTOMATION_STEPS_QUEUE,
) {
  return createQueue<StepJobData>(queueName);
}

/** Idempotent: `<runId>-<sequence>` identifies one step execution. */
export function createStepEnqueuer(
  queueName: string = AUTOMATION_STEPS_QUEUE,
): EnqueueStep {
  return async (data) => {
    await getAutomationStepsQueue(queueName).add("step", data, {
      jobId: `${data.runId}-${data.sequence}`,
    });
  };
}
