import { z } from "zod";
import type { ActionStep } from "../step.types";

export const replyToCommentInput = z.object({
  accountId: z.string().min(1),
  commentId: z.string().min(1),
  text: z.string().min(1),
});

export type ReplyToCommentInput = z.infer<typeof replyToCommentInput>;

export interface ReplyToCommentOutput {
  replyId: string;
}

export const replyToCommentStep: ActionStep<
  ReplyToCommentInput,
  ReplyToCommentOutput
> = {
  kind: "action",
  type: "reply_to_comment",
  description: "Replies publicly to a comment.",
  inputSchema: replyToCommentInput,
  outcomes: ["ok"],
  async execute(input, ctx) {
    const { replyId } = await ctx.socialMedia.commentOnPost({
      ...input,
      idempotencyKey: ctx.idempotencyKey,
    });
    return { outcome: "ok", output: { replyId } };
  },
};
