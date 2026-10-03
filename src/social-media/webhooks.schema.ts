import { type Static, t } from "elysia";

/** Subset of Instagram's comment webhook we read. Other `field` values are ignored. */
export const commentWebhookSchema = t.Object({
  object: t.Literal("instagram"),
  entry: t.Array(
    t.Object({
      id: t.String({ minLength: 1, description: "Our Instagram account id" }),
      time: t.Number(),
      changes: t.Array(
        t.Object({
          field: t.String(),
          value: t.Object({
            id: t.String({ minLength: 1, description: "Comment id" }),
            text: t.String(),
            from: t.Object({
              id: t.String({ minLength: 1 }),
              username: t.Optional(t.String()),
            }),
            media: t.Object({ id: t.String({ minLength: 1 }) }),
          }),
        }),
      ),
    }),
  ),
});

/** Subset of Instagram's messaging webhook we read. Entries without message text are ignored. */
export const messageWebhookSchema = t.Object({
  object: t.Literal("instagram"),
  entry: t.Array(
    t.Object({
      id: t.String({ minLength: 1, description: "Our Instagram account id" }),
      time: t.Number(),
      messaging: t.Array(
        t.Object({
          sender: t.Object({ id: t.String({ minLength: 1 }) }),
          recipient: t.Object({ id: t.String({ minLength: 1 }) }),
          timestamp: t.Number(),
          message: t.Optional(
            t.Object({
              mid: t.String({ minLength: 1 }),
              text: t.Optional(t.String()),
              is_echo: t.Optional(t.Boolean()),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const webhookAcceptedSchema = t.Object({ received: t.Number() });

export type CommentWebhook = Static<typeof commentWebhookSchema>;
export type MessageWebhook = Static<typeof messageWebhookSchema>;
