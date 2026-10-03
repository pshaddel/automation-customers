import { describe, expect, test } from "bun:test";
import {
  normalizeCommentWebhook,
  normalizeMessageWebhook,
} from "../webhooks.service";

describe("normalizeCommentWebhook", () => {
  test("turns comment changes into events and drops our own comments and other fields", () => {
    const events = normalizeCommentWebhook({
      object: "instagram",
      entry: [
        {
          id: "acc_1",
          time: 1,
          changes: [
            {
              field: "comments",
              value: {
                id: "cm_1",
                text: "pricing",
                from: { id: "c_1" },
                media: { id: "p_1" },
              },
            },
            {
              field: "comments",
              value: {
                id: "cm_2",
                text: "Sent you a DM!",
                from: { id: "acc_1" },
                media: { id: "p_1" },
              },
            },
            {
              field: "mentions",
              value: {
                id: "cm_3",
                text: "x",
                from: { id: "c_2" },
                media: { id: "p_1" },
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        type: "comment_received",
        eventId: "cm_1",
        accountId: "acc_1",
        postId: "p_1",
        commentId: "cm_1",
        contactId: "c_1",
        text: "pricing",
      },
    ]);
  });
});

describe("normalizeMessageWebhook", () => {
  test("turns messages into events and drops echoes and entries without text", () => {
    const events = normalizeMessageWebhook({
      object: "instagram",
      entry: [
        {
          id: "acc_1",
          time: 1,
          messaging: [
            {
              sender: { id: "c_1" },
              recipient: { id: "acc_1" },
              timestamp: 1,
              message: { mid: "m_1", text: "a@b.co" },
            },
            {
              sender: { id: "acc_1" },
              recipient: { id: "c_1" },
              timestamp: 2,
              message: { mid: "m_2", text: "hi", is_echo: true },
            },
            { sender: { id: "c_1" }, recipient: { id: "acc_1" }, timestamp: 3 },
            {
              sender: { id: "c_1" },
              recipient: { id: "acc_1" },
              timestamp: 4,
              message: { mid: "m_3" },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        type: "message_received",
        eventId: "m_1",
        accountId: "acc_1",
        contactId: "c_1",
        messageId: "m_1",
        text: "a@b.co",
      },
    ]);
  });
});
