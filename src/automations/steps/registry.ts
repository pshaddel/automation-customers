import type { SocialEvent } from "../../social-media/social-media.events";
import { commentReceivedStep } from "./comment_received/comment_received.step";
import { messageReceivedStep } from "./message_received/message_received.step";
import { replyToCommentStep } from "./reply_to_comment/reply_to_comment.step";
import { sendDmStep } from "./send_dm/send_dm.step";
import type { AnyStep, TriggerStep } from "./step.types";

/**
 * The only place step_type strings are mapped to code. Keys are stored in the database
 * (automation_steps.step_type) and must never be renamed; each matches its folder name.
 */
const STEPS: Record<string, AnyStep> = {
  [commentReceivedStep.type]: commentReceivedStep as TriggerStep,
  [messageReceivedStep.type]: messageReceivedStep as TriggerStep,
  [replyToCommentStep.type]: replyToCommentStep,
  [sendDmStep.type]: sendDmStep,
};

export function getStepType(type: string): AnyStep | undefined {
  return Object.hasOwn(STEPS, type) ? STEPS[type] : undefined;
}

export function listStepTypes(): AnyStep[] {
  return Object.values(STEPS);
}

/** Every listener key an event can match, across all trigger types for its event type. */
export function eventKeysFor(event: SocialEvent): string[] {
  const keys = new Set<string>();
  for (const step of listStepTypes())
    if (step.kind === "trigger" && step.eventType === event.type)
      for (const key of step.eventKeys(event)) keys.add(key);
  return [...keys];
}

/** Whether some mid-flow trigger listens for this event type, so an unmatched one is held. */
export function isWaitEventType(eventType: string): boolean {
  return listStepTypes().some(
    (step) =>
      step.kind === "trigger" &&
      step.position === "wait" &&
      step.eventType === eventType,
  );
}
