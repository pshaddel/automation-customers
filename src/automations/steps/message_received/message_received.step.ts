import { z } from "zod";
import type { MessageReceivedEvent } from "../../../social-media/social-media.events";
import type { TriggerStep } from "../step.types";

export const messageReceivedInput = z.object({
  accountId: z.string().min(1),
  contactId: z.string().min(1),
  /** `email`: only a message containing an email address matches. */
  match: z.enum(["any", "email"]),
});

export type MessageReceivedInput = z.infer<typeof messageReceivedInput>;

export interface MessageReceivedOutput {
  messageId: string;
  text: string;
  email: string | null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export const messageReceivedStep: TriggerStep<
  MessageReceivedInput,
  MessageReceivedEvent,
  MessageReceivedOutput
> = {
  kind: "trigger",
  type: "message_received",
  description: "Pauses the run until the contact sends a direct message.",
  eventType: "message_received",
  position: "wait",
  inputSchema: messageReceivedInput,
  outcomes: ["ok"],
  correlationKey: (input) => `dm:${input.accountId}:${input.contactId}`,
  eventKeys: (event) => [`dm:${event.accountId}:${event.contactId}`],
  subjectKey: (event) => `contact:${event.accountId}:${event.contactId}`,
  match(event, input) {
    if (event.accountId !== input.accountId) return null;
    if (event.contactId !== input.contactId) return null;
    const email = EMAIL.exec(event.text)?.[0] ?? null;
    if (input.match === "email" && !email) return null;
    return { messageId: event.messageId, text: event.text, email };
  },
};
