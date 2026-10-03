import { Elysia, t } from "elysia";
import { authPlugin, unauthorizedSchema } from "../auth/auth.plugin";
import { errorSchema, publicUserSchema } from "./users.schema";
import { getUserById, softDeleteUser, updateUser } from "./users.service";

// Users can only see and manage their own account; there is no endpoint that
// exposes other users.
export function usersModule() {
  return new Elysia({ prefix: "/api/me", detail: { tags: ["Users"] } })
    .use(authPlugin)
    .get("", ({ user }) => getUserById(user.id), {
      auth: true,
      response: { 200: publicUserSchema, 401: unauthorizedSchema },
      detail: { summary: "Current user" },
    })
    .patch("", ({ user, body }) => updateUser(user.id, body), {
      auth: true,
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }),
      response: {
        200: publicUserSchema,
        401: unauthorizedSchema,
        404: errorSchema,
      },
      detail: { summary: "Update current user" },
    })
    .delete(
      "",
      async ({ user, status }) => {
        await softDeleteUser(user.id);
        return status(204, undefined);
      },
      {
        auth: true,
        response: { 204: t.Void(), 401: unauthorizedSchema, 404: errorSchema },
        detail: {
          summary: "Delete current user (soft delete); revokes all sessions",
        },
      },
    );
}
