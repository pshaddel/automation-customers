import { t } from "elysia";

export const publicUserSchema = t.Object({
  id: t.String({ format: "uuid" }),
  username: t.String(),
  name: t.String(),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

export const errorSchema = t.Object({ error: t.String(), message: t.String() });
