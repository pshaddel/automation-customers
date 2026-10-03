import { describe, expect, test } from "bun:test";
import type { MessageReceivedEvent } from "../../../../social-media/social-media.events";
import { messageReceivedStep } from "../message_received.step";

const event: MessageReceivedEvent = {
  type: "message_received",
  eventId: "mid_1",
  accountId: "acc_1",
  contactId: "c_1",
  messageId: "mid_1",
  text: "sure, it's Me@Example.com thanks",
};
const input = { accountId: "acc_1", contactId: "c_1", match: "email" as const };

describe("message_received", () => {
  test("email mode extracts the address", () => {
    expect(messageReceivedStep.match(event, input)).toEqual({
      messageId: "mid_1",
      text: event.text,
      email: "Me@Example.com",
    });
  });

  test("email mode ignores messages without an email", () => {
    expect(
      messageReceivedStep.match({ ...event, text: "hi" }, input),
    ).toBeNull();
  });

  test("any mode matches every message from the contact", () => {
    expect(
      messageReceivedStep.match(
        { ...event, text: "hi" },
        { ...input, match: "any" },
      ),
    ).toEqual({ messageId: "mid_1", text: "hi", email: null });
  });

  test("other contacts and accounts don't match", () => {
    expect(
      messageReceivedStep.match({ ...event, contactId: "c_2" }, input),
    ).toBeNull();
    expect(
      messageReceivedStep.match({ ...event, accountId: "acc_2" }, input),
    ).toBeNull();
  });

  test("listener and event keys agree", () => {
    expect(messageReceivedStep.correlationKey(input)).toBe("dm:acc_1:c_1");
    expect(messageReceivedStep.eventKeys(event)).toEqual(["dm:acc_1:c_1"]);
  });
});
