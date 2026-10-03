import { describe, expect, test } from "bun:test";
import type { CommentReceivedEvent } from "../../../../social-media/social-media.events";
import { commentReceivedStep } from "../comment_received.step";

const event: CommentReceivedEvent = {
  type: "comment_received",
  eventId: "cm_1",
  accountId: "acc_1",
  postId: "post_1",
  commentId: "cm_1",
  contactId: "c_1",
  text: "What's the PRICING?",
};

describe("comment_received", () => {
  test("contains matches case-insensitively and outputs the comment", () => {
    expect(
      commentReceivedStep.match(event, {
        accountId: "acc_1",
        matchMode: "contains",
        keyword: "pricing",
      }),
    ).toEqual({
      accountId: "acc_1",
      postId: "post_1",
      commentId: "cm_1",
      contactId: "c_1",
      text: "What's the PRICING?",
    });
  });

  test("exact requires the whole comment", () => {
    const input = {
      accountId: "acc_1",
      matchMode: "exact" as const,
      keyword: "pricing",
    };
    expect(commentReceivedStep.match(event, input)).toBeNull();
    expect(
      commentReceivedStep.match({ ...event, text: " Pricing " }, input),
    ).not.toBeNull();
  });

  test("other accounts and other posts don't match", () => {
    const input = { accountId: "acc_1", matchMode: "any" as const };
    expect(
      commentReceivedStep.match({ ...event, accountId: "acc_2" }, input),
    ).toBeNull();
    expect(
      commentReceivedStep.match(event, { ...input, postId: "post_2" }),
    ).toBeNull();
  });

  test("listener and event keys agree", () => {
    expect(
      commentReceivedStep.correlationKey({
        accountId: "acc_1",
        matchMode: "any",
      }),
    ).toBe(commentReceivedStep.eventKeys(event)[0] ?? "");
    expect(commentReceivedStep.subjectKey(event)).toBe("contact:acc_1:c_1");
  });

  test("keyword is required unless matchMode is any", () => {
    expect(
      commentReceivedStep.inputSchema.safeParse({
        accountId: "a",
        matchMode: "contains",
      }).success,
    ).toBe(false);
    expect(
      commentReceivedStep.inputSchema.safeParse({
        accountId: "a",
        matchMode: "any",
      }).success,
    ).toBe(true);
  });
});
