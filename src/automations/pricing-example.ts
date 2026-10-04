import type { StepDefinition } from "./validation";

/** How long the example waits for the email: just inside Instagram's 24h window. */
export const PRICING_WAIT_SECONDS = 23 * 60 * 60;

/**
 * The brief's automation as step definitions: reply to a "pricing" comment, DM the
 * commenter for their email, wait for it, then DM a link. If no email arrives within
 * PRICING_WAIT_SECONDS, send one reminder and end. Used by the seed and tests.
 */
export function pricingExampleSteps(accountId: string): StepDefinition[] {
  const contact = {
    accountId: "{{trigger.accountId}}",
    contactId: "{{trigger.contactId}}",
  };
  return [
    {
      key: "trigger",
      stepType: "comment_received",
      label: "Comment contains 'pricing'",
      config: { accountId, matchMode: "contains", keyword: "pricing" },
      next: { ok: "reply" },
    },
    {
      key: "reply",
      stepType: "reply_to_comment",
      label: "Reply to the comment",
      config: {
        accountId: "{{trigger.accountId}}",
        commentId: "{{trigger.commentId}}",
        text: "Sent you a DM!",
      },
      next: { ok: "ask" },
    },
    {
      key: "ask",
      stepType: "send_dm",
      label: "Ask for their email",
      config: { ...contact, text: "Hey! What's your email address?" },
      next: { ok: "wait_email" },
    },
    {
      key: "wait_email",
      stepType: "message_received",
      label: "Wait for an email address",
      config: {
        ...contact,
        match: "email",
        timeoutSeconds: PRICING_WAIT_SECONDS,
      },
      next: { ok: "send_link", timeout: "remind" },
    },
    {
      key: "send_link",
      stepType: "send_dm",
      label: "Send the pricing link",
      config: {
        ...contact,
        text: "Thanks {{steps.wait_email.email}}! Here's our pricing: https://example.com/pricing",
      },
      next: {},
    },
    {
      key: "remind",
      stepType: "send_dm",
      label: "Remind them once",
      config: {
        ...contact,
        text: "Still interested? Comment 'pricing' again any time and we'll send the link.",
      },
      next: {},
    },
  ];
}
