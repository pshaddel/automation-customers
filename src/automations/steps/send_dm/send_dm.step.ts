import { z } from "zod";
import type { ActionStep } from "../step.types";

export const sendDmInput = z.object({
  accountId: z.string().min(1),
  contactId: z.string().min(1),
  text: z.string().min(1),
});

export type SendDmInput = z.infer<typeof sendDmInput>;

export interface SendDmOutput {
  messageId: string;
}

export const sendDmStep: ActionStep<SendDmInput, SendDmOutput> = {
  kind: "action",
  type: "send_dm",
  description: "Sends a direct message to a contact.",
  inputSchema: sendDmInput,
  outcomes: ["ok"],
  async execute(input, ctx) {
    const { messageId } = await ctx.socialMedia.sendDm({
      ...input,
      idempotencyKey: ctx.idempotencyKey,
    });
    return { outcome: "ok", output: { messageId } };
  },
};
