import { afterAll, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../db/db";
import type {
  CommentReceivedEvent,
  MessageReceivedEvent,
} from "../../social-media/social-media.events";
import { NoMatchYetError, processEventJob } from "../automation-events.worker";
import type { StepJobData } from "../automation-steps.queue";
import { processStepJob } from "../automation-steps.worker";
import {
  addStep,
  createAutomation,
  publishAutomation,
  updateAutomation,
} from "../automations.service";
import { pricingExampleSteps } from "../pricing-example";
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
  const deps = { socialMedia: social.client, enqueueStep };

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
});
