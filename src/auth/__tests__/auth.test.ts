import { afterAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { closeDb, getDb, initDb } from "../../db/db";
import { errorHandling } from "../../lib/error-handling";
import { usersModule } from "../../users/users.route";
import { authModule } from "../auth.route";

// Integration tests against the dev database. Every user created here gets a `t_` prefix
// and is removed in afterAll. Skipped when Postgres (or the users table) is unavailable.
let dbReady = false;
try {
  initDb(process.env.DATABASE_URL ?? "");
  await getDb()`SELECT 1 FROM users LIMIT 1`;
  dbReady = true;
} catch {
  console.warn(
    "[auth.test] Postgres/users table unavailable; skipping integration tests",
  );
}

const app = new Elysia()
  .use(errorHandling)
  .use(authModule())
  .use(usersModule());
const created: string[] = [];
const password = "correct-horse-battery";

const uniqueUsername = () => `t_${crypto.randomUUID().slice(0, 8)}`;

function request(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: test assertions on loosely-typed JSON bodies
const json = (res: Response): Promise<any> => res.json();

function sidCookie(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith("sid="));
  if (!header) throw new Error("no sid cookie set");
  return header.split(";")[0] ?? "";
}

async function signUp(username = uniqueUsername()) {
  created.push(username);
  const res = await request("POST", "/api/auth/sign-up", {
    body: { username, name: "Test User", password },
  });
  return { res, username };
}

afterAll(async () => {
  if (dbReady && created.length > 0) {
    await getDb()`DELETE FROM users WHERE username IN ${getDb()(created)}`;
  }
  await closeDb();
});

describe.skipIf(!dbReady)("auth", () => {
  test("sign-up sets an httpOnly session cookie and returns the user", async () => {
    const { res, username } = await signUp();
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.username).toBe(username);
    expect(body).not.toHaveProperty("passwordHash");
    const setCookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("sid="));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  test("GET /api/me works with the cookie and returns 401 without it", async () => {
    const { res, username } = await signUp();
    const cookie = sidCookie(res);

    const me = await request("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);
    expect((await json(me)).username).toBe(username);

    const anon = await request("GET", "/api/me");
    expect(anon.status).toBe(401);
    expect((await json(anon)).error).toBe("UNAUTHORIZED");

    const bogus = await request("GET", "/api/me", {
      cookie: "sid=not-a-real-token",
    });
    expect(bogus.status).toBe(401);
  });

  test("sign-in: correct password succeeds, wrong password and unknown user return 401", async () => {
    const { username } = await signUp();

    const ok = await request("POST", "/api/auth/sign-in", {
      body: { username, password },
    });
    expect(ok.status).toBe(200);
    expect(sidCookie(ok)).toStartWith("sid=");

    const wrong = await request("POST", "/api/auth/sign-in", {
      body: { username, password: "wrong-password" },
    });
    expect(wrong.status).toBe(401);
    const wrongBody = await json(wrong);

    const unknown = await request("POST", "/api/auth/sign-in", {
      body: { username: uniqueUsername(), password },
    });
    expect(unknown.status).toBe(401);
    expect(await json(unknown)).toEqual(wrongBody);
  });

  test("duplicate username returns 409", async () => {
    const { username } = await signUp();
    const dup = await request("POST", "/api/auth/sign-up", {
      body: { username, name: "Again", password },
    });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("CONFLICT");
  });

  test("invalid sign-up body returns 422", async () => {
    const res = await request("POST", "/api/auth/sign-up", {
      body: { username: "AB", name: "", password: "x" },
    });
    expect(res.status).toBe(422);
  });

  test("sign-out revokes the session", async () => {
    const { res } = await signUp();
    const cookie = sidCookie(res);
    const out = await request("POST", "/api/auth/sign-out", { cookie });
    expect(out.status).toBe(204);
    expect((await request("GET", "/api/me", { cookie })).status).toBe(401);
  });

  test("soft-delete: old cookie and sign-in both return 401", async () => {
    const { res, username } = await signUp();
    const cookie = sidCookie(res);
    const del = await request("DELETE", "/api/me", { cookie });
    expect(del.status).toBe(204);

    expect((await request("GET", "/api/me", { cookie })).status).toBe(401);
    const signIn = await request("POST", "/api/auth/sign-in", {
      body: { username, password },
    });
    expect(signIn.status).toBe(401);

    // Username stays reserved after soft delete.
    const reuse = await request("POST", "/api/auth/sign-up", {
      body: { username, name: "Reuse", password },
    });
    expect(reuse.status).toBe(409);
  });

  test("me: get and update own profile", async () => {
    const { res } = await signUp();
    const cookie = sidCookie(res);

    const me = await request("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);

    const patched = await request("PATCH", "/api/me", {
      cookie,
      body: { name: "Renamed" },
    });
    expect(patched.status).toBe(200);
    expect((await json(patched)).name).toBe("Renamed");
  });

  test("other users are not exposed", async () => {
    const { res } = await signUp();
    const cookie = sidCookie(res);
    expect((await request("GET", "/api/users", { cookie })).status).toBe(404);
  });
});
