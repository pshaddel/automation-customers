import { Elysia } from "elysia";
import { AUTOMATION_EVENTS_QUEUE } from "../automations/automation-events.queue";
import {
  commentWebhookSchema,
  messageWebhookSchema,
  webhookAcceptedSchema,
} from "./webhooks.schema";
import {
  ingestEvents,
  normalizeCommentWebhook,
  normalizeMessageWebhook,
} from "./webhooks.service";

/**
 * Simulated Instagram webhooks. Real Instagram uses one callback URL and signs requests
 * with X-Hub-Signature-256; these dummy endpoints skip signature verification.
 * `eventsQueueName` is overridable so tests run against an isolated queue.
 */
export function webhooksModule({
  eventsQueueName = AUTOMATION_EVENTS_QUEUE,
}: {
  eventsQueueName?: string;
} = {}) {
  return new Elysia({
    prefix: "/api/social-media/webhooks",
    detail: { tags: ["Webhooks"] },
  })
    .post(
      "/comments",
      async ({ body }) => ({
        received: await ingestEvents(
          normalizeCommentWebhook(body),
          eventsQueueName,
        ),
      }),
      {
        body: commentWebhookSchema,
        response: { 200: webhookAcceptedSchema },
        detail: { summary: "Simulated Instagram comment webhook" },
      },
    )
    .post(
      "/messages",
      async ({ body }) => ({
        received: await ingestEvents(
          normalizeMessageWebhook(body),
          eventsQueueName,
        ),
      }),
      {
        body: messageWebhookSchema,
        response: { 200: webhookAcceptedSchema },
        detail: { summary: "Simulated Instagram messaging webhook" },
      },
    );
}
