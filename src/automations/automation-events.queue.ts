import { createQueue } from "../lib/queue";
import type { SocialEvent } from "../social-media/social-media.events";

export const AUTOMATION_EVENTS_QUEUE = "automation-events";

export type AutomationEventJobData = SocialEvent;

export function getAutomationEventsQueue(
  queueName: string = AUTOMATION_EVENTS_QUEUE,
) {
  return createQueue<AutomationEventJobData>(queueName);
}

/** BullMQ forbids `:` in custom job ids. */
export function eventJobId(event: SocialEvent): string {
  return `${event.type}-${event.eventId}`.replaceAll(":", "_");
}

/** Idempotent: a duplicate webhook for the same event is ignored while the job exists. */
export async function enqueueEvent(
  event: SocialEvent,
  queueName: string = AUTOMATION_EVENTS_QUEUE,
): Promise<void> {
  await getAutomationEventsQueue(queueName).add(event.type, event, {
    jobId: eventJobId(event),
  });
}
