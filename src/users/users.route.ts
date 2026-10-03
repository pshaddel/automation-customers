import { Elysia, t } from "elysia";
import { authPlugin, unauthorizedSchema } from "../auth/auth.plugin";
import { errorSchema, publicUserSchema } from "./users.schema";
import {
  getUserById,
  listUsers,
  softDeleteUser,
  updateUser,
} from "./users.service";

const idParams = t.Object({ id: t.String({ format: "uuid" }) });
const forbidden = {
  error: "FORBIDDEN",
  message: "You can only modify your own account",
} as const;

// Authorization model: any signed-in user can read users; writes are limited to self.
// Roles/admin permissions are out of scope for now.
export function usersModule() {
  return new Elysia({ prefix: "/api", detail: { tags: ["Users"] } })
    .use(authPlugin)
    .get("/me", ({ user }) => getUserById(user.id), {
      auth: true,
      response: { 200: publicUserSchema, 401: unauthorizedSchema },
      detail: { summary: "Current user" },
    })
    .get(
      "/users",
      ({ query }) =>
        listUsers({ limit: query.limit ?? 20, offset: query.offset ?? 0 }),
      {
        auth: true,
        query: t.Object({
          limit: t.Optional(
            t.Integer({ minimum: 1, maximum: 100, default: 20 }),
          ),
          offset: t.Optional(t.Integer({ minimum: 0, default: 0 })),
        }),
        response: {
          200: t.Object({
            items: t.Array(publicUserSchema),
            total: t.Integer(),
          }),
          401: unauthorizedSchema,
        },
        detail: { summary: "List active users" },
      },
    )
    .get("/users/:id", ({ params }) => getUserById(params.id), {
      auth: true,
      params: idParams,
      response: {
        200: publicUserSchema,
        401: unauthorizedSchema,
        404: errorSchema,
      },
      detail: { summary: "Get a user" },
    })
    .patch(
      "/users/:id",
      async ({ params, body, user, status }) => {
        if (params.id !== user.id) return status(403, forbidden);
        return updateUser(params.id, body);
      },
      {
        auth: true,
        params: idParams,
        body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }),
        response: {
          200: publicUserSchema,
          401: unauthorizedSchema,
          403: errorSchema,
          404: errorSchema,
        },
        detail: { summary: "Update a user (self only)" },
      },
    )
    .delete(
      "/users/:id",
      async ({ params, user, status }) => {
        if (params.id !== user.id) return status(403, forbidden);
        await softDeleteUser(params.id);
        return status(204, undefined);
      },
      {
        auth: true,
        params: idParams,
        response: {
          204: t.Void(),
          401: unauthorizedSchema,
          403: errorSchema,
          404: errorSchema,
        },
        detail: {
          summary: "Soft-delete a user (self only); revokes their sessions",
        },
      },
    );
}
