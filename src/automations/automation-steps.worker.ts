import { type Job, UnrecoverableError, Worker } from "bullmq";
import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import {
  getSocialMediaClient,
  type SocialMediaClient,
} from "../social-media/social-media.client";
import {
  AUTOMATION_STEPS_QUEUE,
  createStepEnqueuer,
  type EnqueueStep,
  type StepJobData,
} from "./automation-steps.queue";
import {
  completeStep,
  failStepRun,
  getRun,
  getStep,
  getStepRun,
  handleStepFailure,
  startStepRun,
  waitOnTrigger,
} from "./runs.service";
import { getStepType } from "./steps/registry";
import { resolveTemplates } from "./template";

export interface StepWorkerDeps {
  socialMedia: SocialMediaClient;
  enqueueStep: EnqueueStep;
}

export type StepJobResult =
  | { status: "completed"; nextStepId: string | null }
  | { status: "waiting" }
  | { status: "skipped"; reason: string };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The step runner: executes one step of one run. Step implementations stay pure; this
 * function owns every status write. See docs/automation.md, "Step job: the runner".
 */
export async function processStepJob(
  job: Job<StepJobData>,
  deps: StepWorkerDeps,
): Promise<StepJobResult> {
  const { runId, stepId, sequence } = job.data;
  const attempt = job.attemptsMade + 1;
  const log = { source: "automationStepsWorker", runId, stepId, sequence };
  logger.info({ event: "automation_step_job_started", ...log, attempt });

  const skip = (reason: string): StepJobResult => {
    logger.info({ event: "automation_step_job_skipped", ...log, reason });
    return { status: "skipped", reason };
  };

  const [run, step, existing] = await Promise.all([
    getRun(runId),
    getStep(stepId),
    getStepRun(runId, sequence),
  ]);
  if (!run || !step) return skip("run or step no longer exists");
  if (run.status !== "running") return skip(`run is ${run.status}`);

  // A previous attempt committed but crashed before enqueueing the next step.
  // The run's next sequence is always stepCount + 1.
  if (existing?.status === "succeeded") {
    if (run.currentStepId)
      await deps.enqueueStep({
        runId,
        stepId: run.currentStepId,
        sequence: run.stepCount + 1,
      });
    return skip("step already succeeded");
  }
  if (existing?.status === "waiting") return skip("step is already waiting");
  if (!existing && run.currentStepId !== stepId)
    return skip("stale job: run has moved on");

  try {
    const type = getStepType(step.stepType);
    if (!type)
      throw new UnrecoverableError(`Unknown step type '${step.stepType}'`);

    let input: unknown;
    try {
      input = type.inputSchema.parse(
        resolveTemplates(step.config, run.context),
      );
    } catch (error) {
      throw new UnrecoverableError(`Invalid input: ${errorMessage(error)}`);
    }
    await startStepRun({ runId, stepId, sequence, attempt, input });

    if (type.kind === "trigger") {
      await waitOnTrigger({
        runId,
        step,
        sequence,
        eventType: type.eventType,
        correlationKey: type.correlationKey(input),
      });
      logger.info({ event: "automation_run_waiting", ...log });
      return { status: "waiting" };
    }

    const result = await type.execute(input, {
      runId,
      sequence,
      attempt,
      idempotencyKey: `${runId}-${sequence}`,
      socialMedia: deps.socialMedia,
    });
    if (!type.outcomes.includes(result.outcome))
      throw new UnrecoverableError(
        `Step returned unknown outcome '${result.outcome}'`,
      );

    const nextStepId = await completeStep({
      runId,
      step,
      sequence,
      output: result.output,
      outcome: result.outcome,
    });
    if (nextStepId)
      await deps.enqueueStep({
        runId,
        stepId: nextStepId,
        sequence: sequence + 1,
      });
    logger.info({
      event: "automation_step_job_completed",
      ...log,
      outcome: result.outcome,
      nextStepId,
    });
    return { status: "completed", nextStepId };
  } catch (error) {
    const message = errorMessage(error);
    await failStepRun({ runId, stepId, sequence, attempt, error: message });

    const isFinal =
      error instanceof UnrecoverableError ||
      attempt >= (job.opts.attempts ?? 1);
    if (isFinal) {
      const nextStepId = await handleStepFailure({
        runId,
        step,
        sequence,
        error: message,
      });
      if (nextStepId)
        await deps.enqueueStep({
          runId,
          stepId: nextStepId,
          sequence: sequence + 1,
        });
      logger.warn({
        event: "automation_step_failed_permanently",
        ...log,
        error: message,
        errorBranch: nextStepId !== null,
      });
    }
    throw error;
  }
}

/** `queueName` is overridable so tests run against an isolated queue. */
export function startAutomationStepsWorker({
  queueName = AUTOMATION_STEPS_QUEUE,
  socialMedia = getSocialMediaClient(),
}: {
  queueName?: string;
  socialMedia?: SocialMediaClient;
} = {}) {
  const deps: StepWorkerDeps = {
    socialMedia,
    enqueueStep: createStepEnqueuer(queueName),
  };
  const worker = new Worker<StepJobData, StepJobResult>(
    queueName,
    (job) => processStepJob(job, deps),
    { connection: getRedisConnection(), concurrency: 10 },
  );

  // Logging only; failure state is written inside the processor.
  worker.on("failed", (job, err) => {
    if (!job) return;
    logger.error({
      event: "automation_step_job_failed",
      source: "automationStepsWorker",
      jobId: job.id,
      runId: job.data.runId,
      attempt: job.attemptsMade,
      error: err.message,
    });
  });

  worker.on("error", (err) => {
    logger.error({
      event: "automation_steps_worker_error",
      source: "automationStepsWorker",
      error: err.message,
    });
  });

  return worker;
}
