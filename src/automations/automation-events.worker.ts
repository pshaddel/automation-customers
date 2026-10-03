import { type Job, Worker } from "bullmq";
import { logger } from "../lib/logger";
import { getRedisConnection } from "../lib/redis";
import type { SocialEvent } from "../social-media/social-media.events";
import {
  AUTOMATION_EVENTS_QUEUE,
  type AutomationEventJobData,
} from "./automation-events.queue";
import {
  AUTOMATION_STEPS_QUEUE,
  createStepEnqueuer,
  type EnqueueStep,
} from "./automation-steps.queue";
import {
  findListeners,
  type ListenerMatch,
  resumeRun,
  startRun,
} from "./runs.service";
import { eventKeysFor, getStepType } from "./steps/registry";

export interface EventWorkerDeps {
  enqueueStep: EnqueueStep;
}

export type EventJobResult =
  | { matched: "wait"; runId: string }
  | { matched: "entry"; runIds: string[] }
  | { matched: "none" };

/** Thrown to make BullMQ retry the match (with backoff) when nothing matched yet. */
export class NoMatchYetError extends Error {
  constructor(event: SocialEvent) {
    super(`No listener matched ${event.type} ${event.eventId} yet`);
    this.name = "NoMatchYetError";
  }
}

/** The trigger's output if the event matches this listener, else null. */
function evaluate(listener: ListenerMatch, event: SocialEvent): unknown {
  const type = getStepType(listener.stepType);
  if (type?.kind !== "trigger" || type.eventType !== event.type) return null;
  // Wait listeners match against the input resolved when the run started waiting;
  // entry trigger config has no templates, so it is the input.
  const parsed = type.inputSchema.safeParse(
    listener.runId ? listener.waitInput : listener.config,
  );
  return parsed.success ? type.match(event, parsed.data) : null;
}

/**
 * Matches one incoming event to listeners. Wait listeners win over entry listeners.
 * When nothing matches, throws NoMatchYetError so BullMQ retries: a reply can arrive
 * before its run has registered the wait listener.
 */
export async function processEventJob(
  job: Job<AutomationEventJobData>,
  deps: EventWorkerDeps,
): Promise<EventJobResult> {
  const event = job.data;
  const attempt = job.attemptsMade + 1;
  const log = {
    source: "automationEventsWorker",
    eventType: event.type,
    eventId: event.eventId,
  };
  logger.info({ event: "automation_event_job_started", ...log, attempt });

  const listeners = await findListeners(event.type, eventKeysFor(event));
  const matches = listeners
    .map((listener) => ({ listener, output: evaluate(listener, event) }))
    .filter((m) => m.output !== null);

  for (const { listener, output } of matches.filter((m) => m.listener.runId)) {
    const resumed = await resumeRun(listener, output);
    if (!resumed) continue; // claimed by a concurrent event; try the next one
    if (resumed.nextStepId)
      await deps.enqueueStep({
        runId: resumed.runId,
        stepId: resumed.nextStepId,
        sequence: resumed.sequence,
      });
    logger.info({
      event: "automation_run_resumed",
      ...log,
      runId: resumed.runId,
    });
    return { matched: "wait", runId: resumed.runId };
  }

  const entryMatches = matches.filter((m) => !m.listener.runId);
  if (entryMatches.length > 0) {
    const runIds: string[] = [];
    for (const { listener, output } of entryMatches) {
      const type = getStepType(listener.stepType);
      if (type?.kind !== "trigger") continue;
      const started = await startRun({
        listener,
        triggerEventId: `${event.type}:${event.eventId}`,
        subjectKey: type.subjectKey(event),
        output,
      });
      if (!started) continue; // the subject already has an active run
      runIds.push(started.runId);
      if (started.nextStepId)
        await deps.enqueueStep({
          runId: started.runId,
          stepId: started.nextStepId,
          sequence: started.sequence,
        });
      logger.info({
        event: started.duplicate
          ? "automation_run_duplicate_event"
          : "automation_run_started",
        ...log,
        runId: started.runId,
        automationId: listener.automationId,
      });
    }
    return { matched: "entry", runIds };
  }

  if (attempt < (job.opts.attempts ?? 1)) throw new NoMatchYetError(event);
  logger.info({ event: "automation_event_unmatched", ...log, attempt });
  return { matched: "none" };
}

/** Queue names are overridable so tests run against isolated queues. */
export function startAutomationEventsWorker({
  queueName = AUTOMATION_EVENTS_QUEUE,
  stepsQueueName = AUTOMATION_STEPS_QUEUE,
}: {
  queueName?: string;
  stepsQueueName?: string;
} = {}) {
  const deps: EventWorkerDeps = {
    enqueueStep: createStepEnqueuer(stepsQueueName),
  };
  const worker = new Worker<AutomationEventJobData, EventJobResult>(
    queueName,
    (job) => processEventJob(job, deps),
    { connection: getRedisConnection(), concurrency: 10 },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    // NoMatchYetError is an expected retry, not a failure worth an error log.
    const level = err instanceof NoMatchYetError ? "info" : "error";
    logger[level]({
      event: "automation_event_job_failed",
      source: "automationEventsWorker",
      jobId: job.id,
      attempt: job.attemptsMade,
      error: err.message,
    });
  });

  worker.on("error", (err) => {
    logger.error({
      event: "automation_events_worker_error",
      source: "automationEventsWorker",
      error: err.message,
    });
  });

  return worker;
}
