import { Elysia, t } from "elysia";
import { errorSchema, publicUserSchema } from "../users/users.schema";
import {
  authPlugin,
  clearSessionCookie,
  sessionCookieSchema,
  setSessionCookie,
  unauthorizedSchema,
} from "./auth.plugin";
import { deleteSession, signIn, signUp } from "./auth.service";

const signUpBody = t.Object({
  username: t.String({ minLength: 3, maxLength: 32, pattern: "^[a-z0-9_]+$" }),
  name: t.String({ minLength: 1, maxLength: 100 }),
  password: t.String({ minLength: 8, maxLength: 128 }),
});

const signInBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 32 }),
  password: t.String({ minLength: 1, maxLength: 128 }),
});

export function authModule() {
  return new Elysia({ prefix: "/api/auth", detail: { tags: ["Auth"] } })
    .use(authPlugin)
    .post(
      "/sign-up",
      async ({ body, cookie, status }) => {
        const { user, session } = await signUp(body);
        setSessionCookie(cookie.sid, session.token, session.expiresAt);
        return status(201, user);
      },
      {
        body: signUpBody,
        cookie: sessionCookieSchema,
        response: { 201: publicUserSchema, 409: errorSchema, 422: errorSchema },
        detail: { summary: "Create an account and start a session" },
      },
    )
    .post(
      "/sign-in",
      async ({ body, cookie }) => {
        const { user, session } = await signIn(body);
        setSessionCookie(cookie.sid, session.token, session.expiresAt);
        return user;
      },
      {
        body: signInBody,
        cookie: sessionCookieSchema,
        response: { 200: publicUserSchema, 401: errorSchema, 422: errorSchema },
        detail: { summary: "Sign in with username and password" },
      },
    )
    .post(
      "/sign-out",
      async ({ cookie, status }) => {
        const sid = cookie.sid;
        if (typeof sid.value === "string" && sid.value)
          await deleteSession(sid.value);
        clearSessionCookie(sid);
        return status(204, undefined);
      },
      {
        auth: true,
        response: { 204: t.Void(), 401: unauthorizedSchema },
        detail: { summary: "End the current session" },
      },
    );
}
