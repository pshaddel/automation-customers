import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authModule } from "../../auth/auth.route";
import { loadConfig } from "../../config/config";
import { getDb } from "../../db/db";
import { errorHandling } from "../../lib/error-handling";
import { closeQueues, createQueue } from "../../lib/queue";
import { closeRedis } from "../../lib/redis";
import { webhooksModule } from "../../social-media/webhooks.route";
import { startAutomationEventsWorker } from "../automation-events.worker";
import { startAutomationStepsWorker } from "../automation-steps.worker";
import { automationsModule } from "../automations.route";
import { pricingExampleSteps } from "../pricing-example";
import {
  fakeSocialMedia,
  prepareDb,
  redisReachable,
  uniqueId,
} from "./helpers";

// The whole flow over HTTP, BullMQ and both workers, on queues unique to this file.
const config = loadConfig();
const ready =
  (await prepareDb("e2e.test")) && (await redisReachable(config.REDIS_URL));

const eventsQueue = `automation-events-test-${crypto.randomUUID()}`;
const stepsQueue = `automation-steps-test-${crypto.randomUUID()}`;
const social = fakeSocialMedia();
const app = new Elysia()
  .use(errorHandling)
  .use(authModule())
  .use(automationsModule())
  .use(webhooksModule({ eventsQueueName: eventsQueue }));
const username = uniqueId("t");

// biome-ignore lint/suspicious/noExplicitAny: test assertions on loosely-typed JSON bodies
type Json = any;

async function call(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as Json,
    res,
  };
}

async function until<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 10_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!ready)("automation end to end (integration)", () => {
  let workers: { close(): Promise<void> }[] = [];

  beforeAll(async () => {
    const events = startAutomationEventsWorker({
      queueName: eventsQueue,
      stepsQueueName: stepsQueue,
    });
    const steps = startAutomationStepsWorker({
      queueName: stepsQueue,
      socialMedia: social.client,
    });
    workers = [events, steps];
    await Promise.all([events.waitUntilReady(), steps.waitUntilReady()]);
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    for (const name of [eventsQueue, stepsQueue])
      await createQueue(name).obliterate({ force: true });
    await closeQueues();
    await closeRedis();
    await getDb()`DELETE FROM users WHERE username = ${username}`;
  });

  test("comment → reply + DM → wait → non-email ignored → email → link → completed", async () => {
    const signUp = await call("POST", "/api/auth/sign-up", {
      username,
      name: "E2E",
      password: "correct-horse-battery",
    });
    const cookie = signUp.res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const accountId = uniqueId("acc");

    const { body: automation } = await call(
      "POST",
      "/api/automations",
      { name: "Pricing" },
      cookie,
    );
    for (const step of pricingExampleSteps(accountId))
      await call(
        "POST",
        `/api/automations/${automation.id}/steps`,
        step,
        cookie,
      );
    expect(
      (
        await call(
          "POST",
          `/api/automations/${automation.id}/publish`,
          undefined,
          cookie,
        )
      ).status,
    ).toBe(200);
    await call(
      "PATCH",
      `/api/automations/${automation.id}`,
      { active: true },
      cookie,
    );

    const comment = await call("POST", "/api/social-media/webhooks/comments", {
      object: "instagram",
      entry: [
        {
          id: accountId,
          time: Date.now(),
          changes: [
            {
              field: "comments",
              value: {
                id: uniqueId("cm"),
                text: "What's the pricing?",
                from: { id: "c_1" },
                media: { id: "p_1" },
              },
            },
          ],
        },
      ],
    });
    expect(comment.body).toEqual({ received: 1 });

    const runs = () =>
      call(
        "GET",
        `/api/automations/${automation.id}/runs`,
        undefined,
        cookie,
      ).then((r) => r.body);
    const [waiting] = await until(runs, (r) => r[0]?.status === "waiting");
    expect(waiting.currentStepKey).toBe("wait_email");
    expect(social.commentOnPost).toHaveBeenCalledTimes(1);
    expect(social.sendDm).toHaveBeenCalledTimes(1);

    const dm = (text: string) =>
      call("POST", "/api/social-media/webhooks/messages", {
        object: "instagram",
        entry: [
          {
            id: accountId,
            time: Date.now(),
            messaging: [
              {
                sender: { id: "c_1" },
                recipient: { id: accountId },
                timestamp: Date.now(),
                message: { mid: uniqueId("mid"), text },
              },
            ],
          },
        ],
      });

    await dm("hold on");
    await Bun.sleep(300);
    expect((await runs())[0].status).toBe("waiting");

    await dm("it's me@example.com");
    const [done] = await until(runs, (r) => r[0]?.status === "completed");
    expect(social.sendDm).toHaveBeenCalledTimes(2);

    const detail = await call(
      "GET",
      `/api/automations/${automation.id}/runs/${done.id}`,
      undefined,
      cookie,
    );
    expect(detail.body.steps.map((s: Json) => [s.stepKey, s.status])).toEqual([
      ["trigger", "succeeded"],
      ["reply", "succeeded"],
      ["ask", "succeeded"],
      ["wait_email", "succeeded"],
      ["send_link", "succeeded"],
    ]);
    expect(detail.body.context.steps.wait_email.email).toBe("me@example.com");

    const list = await call("GET", "/api/automations", undefined, cookie);
    expect(list.body[0].runs.completed).toBe(1);
  }, 20_000);
});
