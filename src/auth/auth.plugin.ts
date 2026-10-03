import { type Cookie, Elysia, t } from "elysia";
import { getSessionUser } from "./auth.service";

export const SESSION_COOKIE = "sid";

const isProduction = () => process.env.NODE_ENV === "production";

export function setSessionCookie(
  cookie: Cookie<unknown>,
  token: string,
  expiresAt: Date,
): void {
  cookie.set({
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isProduction(),
    expires: expiresAt,
  });
}

export function clearSessionCookie(cookie: Cookie<unknown>): void {
  cookie.set({
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isProduction(),
    expires: new Date(0),
    maxAge: 0,
  });
}

/** Cookie schema for routes that read/write the session cookie. */
export const sessionCookieSchema = t.Cookie({
  [SESSION_COOKIE]: t.Optional(t.String()),
});

export const unauthorizedSchema = t.Object({
  error: t.Literal("UNAUTHORIZED"),
  message: t.String(),
});

/**
 * Usage: `.use(authPlugin).get("/x", ({ user }) => user, { auth: true })`.
 * Resolves `user: PublicUser` from the `sid` cookie or short-circuits with 401.
 */
export const authPlugin = new Elysia({ name: "auth" }).macro({
  auth: {
    cookie: sessionCookieSchema,
    detail: { security: [{ cookieAuth: [] }] },
    async resolve({ cookie, status }) {
      const token = cookie[SESSION_COOKIE]?.value;
      const user =
        typeof token === "string" && token ? await getSessionUser(token) : null;
      if (!user) {
        return status(401, {
          error: "UNAUTHORIZED" as const,
          message: "Authentication required",
        });
      }
      return { user };
    },
  },
});
