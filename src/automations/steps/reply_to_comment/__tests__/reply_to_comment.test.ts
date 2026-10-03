import { describe, expect, mock, test } from "bun:test";
import type { SocialMediaClient } from "../../../../social-media/social-media.client";
import { replyToCommentStep } from "../reply_to_comment.step";

describe("reply_to_comment", () => {
  test("replies through the client with the idempotency key", async () => {
    const commentOnPost = mock(async () => ({ replyId: "r_1" }));
    const socialMedia = {
      commentOnPost,
      sendDm: mock(),
    } as unknown as SocialMediaClient;

    const result = await replyToCommentStep.execute(
      { accountId: "acc_1", commentId: "cm_1", text: "Sent you a DM!" },
      {
        runId: "run",
        sequence: 2,
        attempt: 1,
        idempotencyKey: "run-2",
        socialMedia,
      },
    );

    expect(result).toEqual({ outcome: "ok", output: { replyId: "r_1" } });
    expect(commentOnPost).toHaveBeenCalledWith({
      accountId: "acc_1",
      commentId: "cm_1",
      text: "Sent you a DM!",
      idempotencyKey: "run-2",
    });
  });
});
