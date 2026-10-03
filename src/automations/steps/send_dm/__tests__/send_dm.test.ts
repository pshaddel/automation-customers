import { describe, expect, mock, test } from "bun:test";
import type { SocialMediaClient } from "../../../../social-media/social-media.client";
import { sendDmStep } from "../send_dm.step";

describe("send_dm", () => {
  test("sends through the client with the idempotency key", async () => {
    const sendDm = mock(async () => ({ messageId: "m_1" }));
    const socialMedia = {
      sendDm,
      commentOnPost: mock(),
    } as unknown as SocialMediaClient;

    const result = await sendDmStep.execute(
      { accountId: "acc_1", contactId: "c_1", text: "What's your email?" },
      {
        runId: "run",
        sequence: 3,
        attempt: 2,
        idempotencyKey: "run-3",
        socialMedia,
      },
    );

    expect(result).toEqual({ outcome: "ok", output: { messageId: "m_1" } });
    expect(sendDm).toHaveBeenCalledWith({
      accountId: "acc_1",
      contactId: "c_1",
      text: "What's your email?",
      idempotencyKey: "run-3",
    });
  });

  test("errors from the client propagate (the runner retries them)", async () => {
    const socialMedia = {
      sendDm: mock(async () => {
        throw new Error("rate limited");
      }),
      commentOnPost: mock(),
    } as unknown as SocialMediaClient;
    await expect(
      sendDmStep.execute(
        { accountId: "a", contactId: "c", text: "t" },
        {
          runId: "r",
          sequence: 1,
          attempt: 1,
          idempotencyKey: "r-1",
          socialMedia,
        },
      ),
    ).rejects.toThrow("rate limited");
  });
});
