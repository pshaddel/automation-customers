import {
  AUTOMATION_EVENTS_QUEUE,
  enqueueEvent,
} from "../automations/automation-events.queue";
import { logger } from "../lib/logger";
import type {
  CommentReceivedEvent,
  MessageReceivedEvent,
  SocialEvent,
} from "./social-media.events";
import type { CommentWebhook, MessageWebhook } from "./webhooks.schema";

/**
 * Comments by our own account (e.g. our "Sent you a DM!" reply) are dropped, otherwise
 * an automation could trigger itself.
 */
export function normalizeCommentWebhook(
  body: CommentWebhook,
): CommentReceivedEvent[] {
  const events: CommentReceivedEvent[] = [];
  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.field !== "comments") continue;
      const { value } = change;
      if (value.from.id === entry.id) continue;
      events.push({
        type: "comment_received",
        eventId: value.id,
        accountId: entry.id,
        postId: value.media.id,
        commentId: value.id,
        contactId: value.from.id,
        text: value.text,
      });
    }
  }
  return events;
}

/**
 * Instagram has one DM conversation per (account, contact) and sends no thread id, so a
 * conversation is identified by `accountId` + `contactId`. Echoes of our own messages
 * and entries without text (reactions, reads) are dropped.
 */
export function normalizeMessageWebhook(
  body: MessageWebhook,
): MessageReceivedEvent[] {
  const events: MessageReceivedEvent[] = [];
  for (const entry of body.entry) {
    for (const item of entry.messaging) {
      const message = item.message;
      if (!message || message.is_echo || message.text === undefined) continue;
      if (item.sender.id === entry.id) continue;
      events.push({
        type: "message_received",
        eventId: message.mid,
        accountId: entry.id,
        contactId: item.sender.id,
        messageId: message.mid,
        text: message.text,
      });
    }
  }
  return events;
}

/** Enqueues one automation-events job per event. Matching happens in the worker, never here. */
export async function ingestEvents(
  events: SocialEvent[],
  queueName: string = AUTOMATION_EVENTS_QUEUE,
): Promise<number> {
  for (const event of events) {
    await enqueueEvent(event, queueName);
    logger.info({
      event: "webhook_event_received",
      source: "webhooks",
      eventType: event.type,
      eventId: event.eventId,
      accountId: event.accountId,
    });
  }
  return events.length;
}
