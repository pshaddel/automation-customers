import { z } from "zod";
import type { CommentReceivedEvent } from "../../../social-media/social-media.events";
import type { TriggerStep } from "../step.types";

export const commentReceivedInput = z
  .object({
    accountId: z.string().min(1),
    matchMode: z.enum(["any", "contains", "exact"]),
    keyword: z.string().min(1).optional(),
    /** Omit to match comments on any post. */
    postId: z.string().min(1).optional(),
  })
  .refine((input) => input.matchMode === "any" || input.keyword, {
    message: "keyword is required unless matchMode is 'any'",
    path: ["keyword"],
  });

export type CommentReceivedInput = z.infer<typeof commentReceivedInput>;

export interface CommentReceivedOutput {
  accountId: string;
  postId: string;
  commentId: string;
  contactId: string;
  text: string;
}

function textMatches(text: string, input: CommentReceivedInput): boolean {
  const keyword = input.keyword?.trim().toLowerCase() ?? "";
  const normalized = text.trim().toLowerCase();
  switch (input.matchMode) {
    case "any":
      return true;
    case "contains":
      return normalized.includes(keyword);
    case "exact":
      return normalized === keyword;
  }
}

export const commentReceivedStep: TriggerStep<
  CommentReceivedInput,
  CommentReceivedEvent,
  CommentReceivedOutput
> = {
  kind: "trigger",
  type: "comment_received",
  description: "Starts the automation when someone comments on a post.",
  eventType: "comment_received",
  position: "entry",
  inputSchema: commentReceivedInput,
  outcomes: ["ok"],
  correlationKey: (input) => `account:${input.accountId}`,
  eventKeys: (event) => [`account:${event.accountId}`],
  subjectKey: (event) => `contact:${event.accountId}:${event.contactId}`,
  match(event, input) {
    if (event.accountId !== input.accountId) return null;
    if (input.postId && event.postId !== input.postId) return null;
    if (!textMatches(event.text, input)) return null;
    return {
      accountId: event.accountId,
      postId: event.postId,
      commentId: event.commentId,
      contactId: event.contactId,
      text: event.text,
    };
  },
};
