import { afterAll, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/db";
import type {
  CommentReceivedEvent,
  MessageReceivedEvent,
} from "../../social-media/social-media.events";
import { NoMatchYetError, processEventJob } from "../automation-events.worker";
import type { StepJobData } from "../automation-steps.queue";
import { processStepJob } from "../automation-steps.worker";
import type { WaitTimeoutJobData } from "../automation-wait-timeouts.queue";
import {
  processWaitTimeoutJob,
  WaitNotExpiredYetError,
} from "../automation-wait-timeouts.worker";
import {
  addStep,
  createAutomation,
  publishAutomation,
  updateAutomation,
} from "../automations.service";
import { PRICING_WAIT_SECONDS, pricingExampleSteps } from "../pricing-example";
import type { StepDefinition } from "../validation";
import {
  createTestUser,
  deleteUsers,
  fakeJob,
  fakeSocialMedia,
  prepareDb,
  uniqueId,
} from "./helpers";

// Drives both processors directly (no Redis) against the dev database.
const dbReady = await prepareDb("execution.test");
const userIds: string[] = [];

afterAll(async () => {
  if (dbReady) await deleteUsers(userIds);
});

async function setup(
  edit: (steps: StepDefinition[]) => StepDefinition[] = (s) => s,
) {
  const userId = await createTestUser();
  userIds.push(userId);
  const accountId = uniqueId("acc");
  const automation = await createAutomation(userId, "Pricing");
  for (const step of edit(pricingExampleSteps(accountId)))
    await addStep(userId, automation.id, step);
  await publishAutomation(userId, automation.id);
  await updateAutomation(userId, automation.id, { active: true });

  const social = fakeSocialMedia();
  const enqueued: StepJobData[] = [];
  const enqueueStep = mock(async (data: StepJobData) => {
    enqueued.push(data);
  });
  const timeouts: { data: WaitTimeoutJobData; expiresAt: Date }[] = [];
  const enqueueWaitTimeout = mock(
    async (data: WaitTimeoutJobData, expiresAt: Date) => {
      timeouts.push({ data, expiresAt });
    },
  );
  const deps = { socialMedia: social.client, enqueueStep, enqueueWaitTimeout };

  const comment = (
    contactId = "c_1",
    text = "pricing?",
  ): CommentReceivedEvent => ({
    type: "comment_received",
    eventId: uniqueId("cm"),
    accountId,
    postId: "p_1",
    commentId: uniqueId("cm"),
    contactId,
    text,
  });
  const message = (text: string, contactId = "c_1"): MessageReceivedEvent => ({
    type: "message_received",
    eventId: uniqueId("mid"),
    accountId,
    contactId,
    messageId: uniqueId("mid"),
    text,
  });
  /** Runs the most recently enqueued step job. */
  const runNextStep = (attemptsMade = 0, attempts = 3) => {
    const data = enqueued.at(-1);
    if (!data) throw new Error("nothing enqueued");
    return processStepJob(fakeJob(data, attemptsMade, attempts), deps);
  };
  const runRow = async (runId: string) => {
    const [row] = await getDb()<
      { status: string; error: string | null; step_count: number }[]
    >`
      SELECT status, error, step_count FROM automation_runs WHERE id = ${runId}
    `;
    return row;
  };
  const stepRuns = (runId: string) =>
    getDb()<
      {
        sequence: number;
        status: string;
        attempt: number;
        outcome: string | null;
      }[]
    >`
      SELECT sequence, status, attempt, outcome FROM automation_step_runs
      WHERE run_id = ${runId} ORDER BY sequence
    `;
  const waitListeners = (runId: string) =>
    getDb()`SELECT correlation_key FROM automation_triggers WHERE run_id = ${runId}`;
  /** Moves the run's wait deadline, e.g. into the past to simulate an elapsed timeout. */
  const setWaitExpiry = (runId: string, seconds: number) =>
    getDb()`
      UPDATE automation_triggers SET expires_at = now() + ${seconds}::int * interval '1 second'
      WHERE run_id = ${runId}
    `;
  /** Runs the most recently scheduled timeout job, as if its delay had elapsed. */
  const runTimeout = (attemptsMade = 0) => {
    const scheduled = timeouts.at(-1);
    if (!scheduled) throw new Error("no timeout scheduled");
    return processWaitTimeoutJob(fakeJob(scheduled.data, attemptsMade), {
      enqueueStep,
    });
  };
  /** Starts a run from a comment and drives it until it waits for the email. */
  const startWaiting = async () => {
    const started = await processEventJob(fakeJob(comment()), deps);
    const runId = started.matched === "entry" ? (started.runIds[0] ?? "") : "";
    await runNextStep(); // reply
    await runNextStep(); // ask
    expect(await runNextStep()).toEqual({ status: "waiting" }); // wait_email
    return runId;
  };

  return {
    userId,
    automationId: automation.id,
    accountId,
    social,
    deps,
    enqueued,
    comment,
    message,
    runNextStep,
    runRow,
    stepRuns,
    waitListeners,
    timeouts,
    setWaitExpiry,
    runTimeout,
    startWaiting,
  };
}

describe.skipIf(!dbReady)("execution (integration)", () => {
  test("the brief's flow: comment → reply → DM → wait → email → link", async () => {
    const t = await setup();

    const started = await processEventJob(fakeJob(t.comment()), t.deps);
    expect(started.matched).toBe("entry");
    const runId = started.matched === "entry" ? (started.runIds[0] ?? "") : "";
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 2 });

    expect(await t.runNextStep()).toMatchObject({ status: "completed" }); // reply
    expect(t.social.commentOnPost).toHaveBeenCalledTimes(1);
    expect(await t.runNextStep()).toMatchObject({ status: "completed" }); // ask
    expect(t.social.sendDm).toHaveBeenCalledTimes(1);
    expect(await t.runNextStep()).toEqual({ status: "waiting" }); // wait_email
    expect((await t.runRow(runId))?.status).toBe("waiting");
    expect(await t.waitListeners(runId)).toEqual([
      { correlation_key: `dm:${t.accountId}:c_1` },
    ]);
    expect(t.timeouts).toHaveLength(1);
    expect(t.timeouts[0]?.data).toMatchObject({ runId, sequence: 4 });
    const waitMs = (t.timeouts[0]?.expiresAt.getTime() ?? 0) - Date.now();
    expect(Math.abs(waitMs - PRICING_WAIT_SECONDS * 1000)).toBeLessThan(60_000);

    // Not an email: retried while attempts remain, then unmatched; the run keeps waiting.
    await expect(
      processEventJob(fakeJob(t.message("hi")), t.deps),
    ).rejects.toBeInstanceOf(NoMatchYetError);
    expect(await processEventJob(fakeJob(t.message("hi"), 2), t.deps)).toEqual({
      matched: "none",
    });
    expect((await t.runRow(runId))?.status).toBe("waiting");

    // Another contact's email doesn't resume this run.
    expect(
      await processEventJob(fakeJob(t.message("x@y.co", "c_2"), 2), t.deps),
    ).toEqual({ matched: "none" });

    expect(
      await processEventJob(fakeJob(t.message("sure: me@example.com")), t.deps),
    ).toEqual({ matched: "wait", runId });
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 5 });
    expect(await t.runNextStep()).toEqual({
      status: "completed",
      nextStepId: null,
    });

    expect(await t.runRow(runId)).toMatchObject({
      status: "completed",
      step_count: 5,
    });
    expect(t.social.sendDm).toHaveBeenCalledTimes(2);
    expect(t.social.sendDm.mock.calls[1]?.[0]).toMatchObject({
      contactId: "c_1",
      idempotencyKey: `${runId}-5`,
    });
    expect(JSON.stringify(t.social.sendDm.mock.calls[1]?.[0])).toContain(
      "me@example.com",
    );
    expect((await t.stepRuns(runId)).map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(await t.waitListeners(runId)).toEqual([]);
  });

  test("duplicate events and repeat comments don't start extra runs", async () => {
    const t = await setup();
    const event = t.comment();
    const first = await processEventJob(fakeJob(event), t.deps);
    const runId = first.matched === "entry" ? first.runIds[0] : undefined;

    // Same event again (e.g. a retried job): same run, its current step re-enqueued.
    const again = await processEventJob(fakeJob(event), t.deps);
    expect(again).toEqual({ matched: "entry", runIds: [runId ?? ""] });
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 2 });

    // Same contact comments again while the run is active: ignored.
    expect(await processEventJob(fakeJob(t.comment()), t.deps)).toEqual({
      matched: "entry",
      runIds: [],
    });
    const [count] = await getDb()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM automation_runs WHERE automation_id = ${t.automationId}
    `;
    expect(count?.n).toBe(1);

    // Comments that don't match the keyword retry, then end unmatched.
    expect(
      await processEventJob(fakeJob(t.comment("c_9", "nice photo"), 2), t.deps),
    ).toEqual({ matched: "none" });
  });

  test("a retried step that already succeeded doesn't run again", async () => {
    const t = await setup();
    await processEventJob(fakeJob(t.comment()), t.deps);
    const replyJob = t.enqueued.at(-1) as StepJobData;
    await t.runNextStep(); // reply succeeds, ask enqueued at sequence 3

    const retry = await processStepJob(fakeJob(replyJob, 1), t.deps);
    expect(retry).toEqual({
      status: "skipped",
      reason: "step already succeeded",
    });
    expect(t.social.commentOnPost).toHaveBeenCalledTimes(1);
    expect(t.enqueued.at(-1)).toMatchObject({ sequence: 3 }); // re-enqueued, same job id
  });

  test("stale jobs are skipped", async () => {
    const t = await setup();
    await processEventJob(fakeJob(t.comment()), t.deps);
    const job = t.enqueued.at(-1) as StepJobData;
    const [other] = await getDb()<{ id: string }[]>`
      SELECT id FROM automation_steps WHERE version_id = (
        SELECT version_id FROM automation_runs WHERE id = ${job.runId}
      ) AND key = 'send_link'
    `;
    expect(
      await processStepJob(
        fakeJob({ ...job, stepId: other?.id ?? "" }),
        t.deps,
      ),
    ).toEqual({ status: "skipped", reason: "stale job: run has moved on" });
  });

  test("a step failing on its last attempt fails the run", async () => {
    const t = await setup();
    t.social.commentOnPost.mockImplementation(async () => {
      throw new Error("platform down");
    });
    const started = await processEventJob(fakeJob(t.comment()), t.deps);
    const runId = started.matched === "entry" ? (started.runIds[0] ?? "") : "";

    await expect(t.runNextStep(0)).rejects.toThrow("platform down");
    expect((await t.runRow(runId))?.status).toBe("running");
    expect((await t.stepRuns(runId)).at(-1)).toMatchObject({
      status: "failed",
      attempt: 1,
    });

    await expect(t.runNextStep(2)).rejects.toThrow("platform down");
    expect(await t.runRow(runId)).toMatchObject({
      status: "failed",
      error: "platform down",
    });
    expect((await t.stepRuns(runId)).at(-1)).toMatchObject({
      status: "failed",
      attempt: 3,
    });
  });

  test("a failing step with next.error continues on the error branch", async () => {
    const t = await setup((steps) =>
      steps.map((s) =>
        s.key === "reply" ? { ...s, next: { ok: "ask", error: "ask" } } : s,
      ),
    );
    t.social.commentOnPost.mockImplementation(async () => {
      throw new Error("comment deleted");
    });
    const started = await processEventJob(fakeJob(t.comment()), t.deps);
    const runId = started.matched === "entry" ? (started.runIds[0] ?? "") : "";

    await expect(t.runNextStep(0, 1)).rejects.toThrow("comment deleted");
    expect((await t.runRow(runId))?.status).toBe("running");
    expect((await t.stepRuns(runId)).at(-1)).toMatchObject({
      status: "failed",
      outcome: "error",
    });
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 3 });
    expect(await t.runNextStep()).toMatchObject({ status: "completed" }); // ask still runs
  });

  test("turning the automation off cancels waiting runs", async () => {
    const t = await setup();
    const started = await processEventJob(fakeJob(t.comment()), t.deps);
    const runId = started.matched === "entry" ? (started.runIds[0] ?? "") : "";
    await t.runNextStep();
    await t.runNextStep();
    await t.runNextStep(); // waiting

    await updateAutomation(t.userId, t.automationId, { active: false });
    expect((await t.runRow(runId))?.status).toBe("cancelled");
    expect(await t.waitListeners(runId)).toEqual([]);
    expect(
      await processEventJob(fakeJob(t.message("me@example.com"), 2), t.deps),
    ).toEqual({ matched: "none" });
    // New comments don't match an inactive automation either.
    expect(await processEventJob(fakeJob(t.comment("c_5"), 2), t.deps)).toEqual(
      {
        matched: "none",
      },
    );
  });

  test("a wait that times out follows next.timeout", async () => {
    const t = await setup();
    const runId = await t.startWaiting();

    await t.setWaitExpiry(runId, -1);
    // Expired: a late reply no longer matches, even before the timeout job runs.
    expect(
      await processEventJob(fakeJob(t.message("me@example.com"), 2), t.deps),
    ).toEqual({ matched: "none" });

    const result = await t.runTimeout();
    expect(result).toMatchObject({ status: "expired" });
    expect(await t.waitListeners(runId)).toEqual([]);
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 5 });
    expect((await t.stepRuns(runId)).at(-1)).toMatchObject({
      sequence: 4,
      status: "succeeded",
      outcome: "timeout",
    });

    expect(await t.runNextStep()).toEqual({
      status: "completed",
      nextStepId: null,
    }); // remind
    expect(t.social.sendDm).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(t.social.sendDm.mock.calls[1]?.[0])).toContain(
      "Still interested?",
    );
    expect(await t.runRow(runId)).toMatchObject({
      status: "completed",
      step_count: 5,
    });

    // A retried timeout job (e.g. it crashed before enqueueing) re-enqueues the next step
    // while the run is still on it, and does nothing once the run has finished.
    const enqueuedBefore = t.enqueued.length;
    expect(await t.runTimeout(1)).toMatchObject({ status: "skipped" });
    expect(t.enqueued).toHaveLength(enqueuedBefore);
  });

  test("a retried timeout job re-enqueues the step after the wait", async () => {
    const t = await setup();
    const runId = await t.startWaiting();
    await t.setWaitExpiry(runId, -1);
    await t.runTimeout();
    t.enqueued.pop(); // as if the first attempt crashed before enqueueing `remind`

    expect(await t.runTimeout(1)).toMatchObject({ status: "skipped" });
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 5 });
  });

  test("without next.timeout, a timed-out wait completes the run", async () => {
    const t = await setup((steps) =>
      steps
        .filter((s) => s.key !== "remind")
        .map((s) =>
          s.key === "wait_email" ? { ...s, next: { ok: "send_link" } } : s,
        ),
    );
    const runId = await t.startWaiting();
    await t.setWaitExpiry(runId, -1);

    expect(await t.runTimeout()).toEqual({
      status: "expired",
      nextStepId: null,
    });
    expect(await t.runRow(runId)).toMatchObject({
      status: "completed",
      step_count: 4,
    });
    expect(t.social.sendDm).toHaveBeenCalledTimes(1);
  });

  test("a reply before the timeout makes the timeout job a no-op", async () => {
    const t = await setup();
    const runId = await t.startWaiting();
    expect(
      await processEventJob(fakeJob(t.message("me@example.com")), t.deps),
    ).toEqual({ matched: "wait", runId });

    expect(await t.runTimeout()).toMatchObject({ status: "skipped" });
    expect((await t.stepRuns(runId)).at(-1)).toMatchObject({
      sequence: 4,
      outcome: "ok",
    });
    expect(t.enqueued.at(-1)).toMatchObject({ runId, sequence: 5 });
  });

  test("a timeout job firing before the deadline retries", async () => {
    const t = await setup();
    const runId = await t.startWaiting();
    await expect(t.runTimeout()).rejects.toBeInstanceOf(WaitNotExpiredYetError);
    expect((await t.runRow(runId))?.status).toBe("waiting");
  });

  test("a retried wait step re-schedules its timeout", async () => {
    const t = await setup();
    const runId = await t.startWaiting();
    const waitJob = t.enqueued.at(-1) as StepJobData;

    expect(await processStepJob(fakeJob(waitJob, 1), t.deps)).toEqual({
      status: "skipped",
      reason: "step is already waiting",
    });
    expect(t.timeouts).toHaveLength(2);
    expect(t.timeouts[1]).toEqual(t.timeouts[0] as (typeof t.timeouts)[0]);
    expect((await t.runRow(runId))?.status).toBe("waiting");
  });
});
