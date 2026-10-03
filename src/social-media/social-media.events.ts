/**
 * Normalized platform events. Webhooks turn Instagram-shaped payloads into these;
 * the automation engine only ever sees this shape.
 */

export interface CommentReceivedEvent {
  type: "comment_received";
  /** Platform id of the event; the comment id. */
  eventId: string;
  accountId: string;
  postId: string;
  commentId: string;
  contactId: string;
  text: string;
}

export interface MessageReceivedEvent {
  type: "message_received";
  /** Platform id of the event; the message id. */
  eventId: string;
  accountId: string;
  contactId: string;
  messageId: string;
  text: string;
}

export type SocialEvent = CommentReceivedEvent | MessageReceivedEvent;

export type SocialEventType = SocialEvent["type"];
