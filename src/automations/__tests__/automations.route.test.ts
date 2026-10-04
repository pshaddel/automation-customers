import { afterAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authModule } from "../../auth/auth.route";
import { getDb } from "../../db/db";
import { errorHandling } from "../../lib/error-handling";
import { automationsModule } from "../automations.route";
import { pricingExampleSteps } from "../pricing-example";
import { prepareDb, uniqueId } from "./helpers";

// Integration tests against the dev database through the HTTP layer. Users are created
// with a `t_` prefix and hard-deleted in afterAll (everything else cascades).
const dbReady = await prepareDb("automations.route.test");

const app = new Elysia()
  .use(errorHandling)
  .use(authModule())
  .use(automationsModule());
const usernames: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: test assertions on loosely-typed JSON bodies
type Json = any;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signUp(): Promise<string> {
  const username = uniqueId("t");
  usernames.push(username);
  const res = await app.handle(
    new Request("http://localhost/api/auth/sign-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        name: "Test",
        password: "correct-horse-battery",
      }),
    }),
  );
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("sid="));
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0] ?? "";
}

async function createPricingAutomation(cookie: string, accountId: string) {
  const created = await call("POST", "/api/automations", {
    cookie,
    body: { name: "Pricing" },
  });
  const id: string = created.body.id;
  for (const step of pricingExampleSteps(accountId))
    expect(
      (
        await call("POST", `/api/automations/${id}/steps`, {
          cookie,
          body: step,
        })
      ).status,
    ).toBe(201);
  return id;
}

async function entryListeners(automationId: string) {
  return getDb()<{ version_id: string; correlation_key: string }[]>`
    SELECT version_id, correlation_key FROM automation_triggers
    WHERE automation_id = ${automationId} AND run_id IS NULL
  `;
}

afterAll(async () => {
  if (!dbReady) return;
  for (const username of usernames)
    await getDb()`DELETE FROM users WHERE username = ${username}`;
});

describe.skipIf(!dbReady)("automations API (integration)", () => {
  test("requires a session", async () => {
    expect((await call("GET", "/api/automations")).status).toBe(401);
  });

  test("lists the step catalog", async () => {
    const cookie = await signUp();
    const res = await call("GET", "/api/automations/step-types", { cookie });
    expect(res.status).toBe(200);
    expect(res.body.map((s: Json) => s.type).sort()).toEqual([
      "comment_received",
      "message_received",
      "reply_to_comment",
      "send_dm",
    ]);
    const trigger = res.body.find((s: Json) => s.type === "comment_received");
    expect(trigger.kind).toBe("trigger");
    expect(trigger.position).toBe("entry");
    expect(trigger.inputSchema.properties.matchMode).toBeDefined();
  });

  test("create, list, rename and delete", async () => {
    const cookie = await signUp();
    const created = await call("POST", "/api/automations", {
      cookie,
      body: { name: "First" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "First",
      active: false,
      publishedVersion: null,
      hasDraft: true,
      draft: { version: 1, steps: [] },
      published: null,
    });
    const id = created.body.id;

    const list = await call("GET", "/api/automations", { cookie });
    expect(list.body.map((a: Json) => a.id)).toEqual([id]);
    expect(list.body[0].runs).toEqual({
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });

    const renamed = await call("PATCH", `/api/automations/${id}`, {
      cookie,
      body: { name: "Renamed" },
    });
    expect(renamed.body.name).toBe("Renamed");

    expect(
      (await call("DELETE", `/api/automations/${id}`, { cookie })).status,
    ).toBe(204);
    expect(
      (await call("GET", `/api/automations/${id}`, { cookie })).status,
    ).toBe(404);
    expect((await call("GET", "/api/automations", { cookie })).body).toEqual(
      [],
    );
  });

  test("other users' automations look missing", async () => {
    const owner = await signUp();
    const other = await signUp();
    const id = await createPricingAutomation(owner, uniqueId("acc"));
    for (const [method, path, body] of [
      ["GET", `/api/automations/${id}`],
      ["PATCH", `/api/automations/${id}`, { name: "x" }],
      ["DELETE", `/api/automations/${id}`],
      ["GET", `/api/automations/${id}/steps`],
      ["POST", `/api/automations/${id}/steps`, pricingExampleSteps("a")[1]],
      ["PATCH", `/api/automations/${id}/steps/reply`, { label: "x" }],
      ["DELETE", `/api/automations/${id}/steps/reply`],
      ["POST", `/api/automations/${id}/publish`],
      ["GET", `/api/automations/${id}/runs`],
    ] as const)
      expect((await call(method, path, { cookie: other, body })).status).toBe(
        404,
      );
    expect(
      (await call("GET", "/api/automations", { cookie: other })).body,
    ).toEqual([]);
  });

  test("step validation on write", async () => {
    const cookie = await signUp();
    const id = await createPricingAutomation(cookie, uniqueId("acc"));
    const step = pricingExampleSteps("a")[1];
    const dup = await call("POST", `/api/automations/${id}/steps`, {
      cookie,
      body: step,
    });
    expect(dup.status).toBe(409);
    const unknown = await call("POST", `/api/automations/${id}/steps`, {
      cookie,
      body: { ...step, key: "other", stepType: "nope" },
    });
    expect(unknown.status).toBe(400);
    const badKey = await call("POST", `/api/automations/${id}/steps`, {
      cookie,
      body: { ...step, key: "Bad Key" },
    });
    expect(badKey.status).toBe(422);
    expect(
      (
        await call("PATCH", `/api/automations/${id}/steps/ghost`, {
          cookie,
          body: { label: "x" },
        })
      ).status,
    ).toBe(404);
  });

  test("publish reports every problem", async () => {
    const cookie = await signUp();
    const id = await createPricingAutomation(cookie, uniqueId("acc"));
    await call("DELETE", `/api/automations/${id}/steps/ask`, { cookie });
    const res = await call("POST", `/api/automations/${id}/publish`, {
      cookie,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION_ERROR");
    expect(res.body.details).toContainEqual({
      stepKey: "reply",
      problem: "next.ok: no step with key 'ask'",
    });
    expect(res.body.details).toContainEqual({
      stepKey: "wait_email",
      problem: "Not reachable from the entry trigger",
    });
  });

  test("publish, activate, edit (copy-on-write), republish, deactivate", async () => {
    const cookie = await signUp();
    const accountId = uniqueId("acc");
    const id = await createPricingAutomation(cookie, accountId);

    const early = await call("PATCH", `/api/automations/${id}`, {
      cookie,
      body: { active: true },
    });
    expect(early.status).toBe(400);

    const published = await call("POST", `/api/automations/${id}/publish`, {
      cookie,
    });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      publishedVersion: 1,
      hasDraft: false,
      draft: null,
    });
    expect(published.body.published.steps).toHaveLength(6);
    expect(
      (await call("POST", `/api/automations/${id}/publish`, { cookie })).status,
    ).toBe(400); // nothing to publish

    await call("PATCH", `/api/automations/${id}`, {
      cookie,
      body: { active: true },
    });
    const [v1Listener] = await entryListeners(id);
    expect(v1Listener?.correlation_key).toBe(`account:${accountId}`);

    // Editing a published automation copies it into draft v2; v1 is untouched.
    const edited = await call("PATCH", `/api/automations/${id}/steps/reply`, {
      cookie,
      body: {
        config: {
          accountId: "{{trigger.accountId}}",
          commentId: "{{trigger.commentId}}",
          text: "Check your DMs",
        },
      },
    });
    expect(edited.status).toBe(200);
    const detail = await call("GET", `/api/automations/${id}`, { cookie });
    expect(detail.body.draft.version).toBe(2);
    expect(detail.body.draft.steps).toHaveLength(6);
    const replyIn = (v: Json) =>
      v.steps.find((s: Json) => s.key === "reply").config.text;
    expect(replyIn(detail.body.draft)).toBe("Check your DMs");
    expect(replyIn(detail.body.published)).toBe("Sent you a DM!");
    const steps = await call("GET", `/api/automations/${id}/steps`, { cookie });
    expect(steps.body).toMatchObject({ version: 2, isDraft: true });

    await call("POST", `/api/automations/${id}/publish`, { cookie });
    const [v2Listener] = await entryListeners(id);
    expect(v2Listener?.version_id).not.toBe(v1Listener?.version_id);

    // Discarding a draft drops it again.
    await call("PATCH", `/api/automations/${id}/steps/reply`, {
      cookie,
      body: { label: "x" },
    });
    expect(
      (await call("DELETE", `/api/automations/${id}/draft`, { cookie })).status,
    ).toBe(204);
    expect(
      (await call("GET", `/api/automations/${id}`, { cookie })).body.hasDraft,
    ).toBe(false);

    await call("PATCH", `/api/automations/${id}`, {
      cookie,
      body: { active: false },
    });
    expect(await entryListeners(id)).toHaveLength(0);
  });
});
