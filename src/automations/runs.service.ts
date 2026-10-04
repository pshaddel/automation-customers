import { type Database, getDb } from "../db/db";
import { NotFoundError } from "../lib/errors";
import type { SocialEvent } from "../social-media/social-media.events";

/**
 * Runs, step runs, wait listeners and unmatched events: the state the workers read and write.
 * Every state transition locks the run row (`FOR UPDATE`) so a resume, a step completion
 * and a cancellation can't interleave.
 */

export const MAX_STEPS_PER_RUN = 50;

export type RunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunContext {
  trigger: Record<string, unknown>;
  steps: Record<string, unknown>;
}

interface RunRow {
  id: string;
  automation_id: string;
  version_id: string;
  trigger_event_id: string;
  subject_key: string;
  status: RunStatus;
  current_step_id: string | null;
  context: RunContext;
  step_count: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface Run {
  id: string;
  automationId: string;
  versionId: string;
  status: RunStatus;
  currentStepId: string | null;
  context: RunContext;
  stepCount: number;
}

interface StepRow {
  id: string;
  version_id: string;
  key: string;
  step_type: string;
  label: string;
  config: Record<string, unknown>;
  next: Record<string, string>;
}

export interface Step {
  id: string;
  versionId: string;
  key: string;
  stepType: string;
  config: Record<string, unknown>;
  next: Record<string, string>;
}

interface StepRunRow {
  status: "running" | "succeeded" | "waiting" | "failed";
  outcome: string | null;
}

const toRun = (row: RunRow): Run => ({
  id: row.id,
  automationId: row.automation_id,
  versionId: row.version_id,
  status: row.status,
  currentStepId: row.current_step_id,
  context: row.context,
  stepCount: row.step_count,
});

const toStep = (row: StepRow): Step => ({
  id: row.id,
  versionId: row.version_id,
  key: row.key,
  stepType: row.step_type,
  config: row.config,
  next: row.next,
});

export async function getRun(
  id: string,
  db: Database = getDb(),
): Promise<Run | null> {
  const [row] = await db<
    RunRow[]
  >`SELECT * FROM automation_runs WHERE id = ${id}`;
  return row ? toRun(row) : null;
}

export async function getStep(
  id: string,
  db: Database = getDb(),
): Promise<Step | null> {
  const [row] = await db<
    StepRow[]
  >`SELECT * FROM automation_steps WHERE id = ${id}`;
  return row ? toStep(row) : null;
}

export async function getStepRun(
  runId: string,
  sequence: number,
): Promise<StepRunRow | null> {
  const [row] = await getDb()<StepRunRow[]>`
    SELECT status, outcome FROM automation_step_runs
    WHERE run_id = ${runId} AND sequence = ${sequence}
  `;
  return row ?? null;
}

async function lockRun(tx: Database, runId: string): Promise<RunRow | null> {
  const [row] = await tx<RunRow[]>`
    SELECT * FROM automation_runs WHERE id = ${runId} FOR UPDATE
  `;
  return row ?? null;
}

async function stepIdByKey(
  tx: Database,
  versionId: string,
  key: string,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM automation_steps WHERE version_id = ${versionId} AND key = ${key}
  `;
  return row?.id ?? null;
}

/**
 * Records a finished step on the (locked) run and moves it to `nextKey`: stores the
 * output in context, bumps step_count, and completes or fails the run when there is no
 * next step or the step cap is hit. Returns the next step id while the run continues.
 */
async function advance(
  tx: Database,
  run: RunRow,
  stepKey: string,
  output: unknown,
  nextKey: string | undefined,
): Promise<string | null> {
  const nextStepId = nextKey
    ? await stepIdByKey(tx, run.version_id, nextKey)
    : null;
  const stepCount = run.step_count + 1;

  let status: RunStatus = nextStepId ? "running" : "completed";
  let error: string | null = null;
  if (nextKey && !nextStepId) {
    status = "failed";
    error = `Next step '${nextKey}' not found`;
  } else if (nextStepId && stepCount >= MAX_STEPS_PER_RUN) {
    status = "failed";
    error = `Step limit of ${MAX_STEPS_PER_RUN} reached`;
  }
  const finished = status !== "running";

  await tx`
    UPDATE automation_runs SET
      context = jsonb_set(context, ARRAY['steps', ${stepKey}], COALESCE(${output ?? null}::jsonb, 'null'::jsonb)),
      step_count = ${stepCount},
      current_step_id = ${finished ? null : nextStepId},
      status = ${status},
      error = ${error},
      finished_at = ${finished ? new Date() : null}
    WHERE id = ${run.id}
  `;
  return finished ? null : nextStepId;
}

export async function startStepRun(params: {
  runId: string;
  stepId: string;
  sequence: number;
  attempt: number;
  input: unknown;
}): Promise<void> {
  const { runId, stepId, sequence, attempt, input } = params;
  await getDb()`
    INSERT INTO automation_step_runs (run_id, step_id, sequence, status, attempt, input)
    VALUES (${runId}, ${stepId}, ${sequence}, 'running', ${attempt}, ${input}::jsonb)
    ON CONFLICT (run_id, sequence) DO UPDATE SET
      status = 'running', attempt = EXCLUDED.attempt, input = EXCLUDED.input,
      error = NULL, started_at = now(), finished_at = NULL
    WHERE automation_step_runs.status IN ('running', 'failed')
  `;
}

/** Marks an action step succeeded and advances the run. Returns the next step id, if any. */
export async function completeStep(params: {
  runId: string;
  step: Step;
  sequence: number;
  output: unknown;
  outcome: string;
}): Promise<string | null> {
  const { runId, step, sequence, output, outcome } = params;
  return getDb().begin(async (tx) => {
    const run = await lockRun(tx, runId);
    if (run?.status !== "running") return null;
    await tx`
      UPDATE automation_step_runs SET
        status = 'succeeded', output = ${output ?? null}::jsonb, outcome = ${outcome},
        error = NULL, finished_at = now()
      WHERE run_id = ${runId} AND sequence = ${sequence}
    `;
    return advance(tx, run, step.key, output, step.next[outcome]);
  });
}

export type WaitResult =
  | { status: "waiting"; expiresAt: Date | null }
  | { status: "resumed"; nextStepId: string | null };

/**
 * Pauses the run on a mid-flow trigger, unless an unmatched event already answers it.
 * Under the conversation lock, it first looks for a held event that arrived after the
 * previous step started and that `match` accepts: if there is one, the event is claimed
 * and the run moves on at once. Otherwise the step run waits and a wait listener is
 * stored, expiring after `timeoutSeconds` if given. Null when the run isn't running.
 */
export async function waitOnTrigger(params: {
  runId: string;
  step: Step;
  sequence: number;
  eventType: string;
  correlationKey: string;
  timeoutSeconds: number | undefined;
  match: (event: SocialEvent) => unknown;
}): Promise<WaitResult | null> {
  const {
    runId,
    step,
    sequence,
    eventType,
    correlationKey,
    timeoutSeconds,
    match,
  } = params;
  return getDb().begin(async (tx) => {
    await lockConversations(tx, [correlationKey]);
    const run = await lockRun(tx, runId);
    if (run?.status !== "running") return null;

    const held = await claimUnmatchedEvent(tx, {
      runId,
      sequence,
      eventType,
      correlationKey,
      match,
    });
    if (held) {
      await tx`
        UPDATE automation_step_runs SET
          status = 'succeeded', output = ${held.output ?? null}::jsonb, outcome = 'ok', finished_at = now()
        WHERE run_id = ${runId} AND sequence = ${sequence}
      `;
      const nextStepId = await advance(
        tx,
        run,
        step.key,
        held.output,
        step.next.ok,
      );
      return { status: "resumed", nextStepId };
    }

    await tx`
      UPDATE automation_step_runs SET status = 'waiting'
      WHERE run_id = ${runId} AND sequence = ${sequence}
    `;
    await tx`
      INSERT INTO automation_triggers (automation_id, version_id, step_id, run_id, event_type, correlation_key, expires_at)
      VALUES (${run.automation_id}, ${run.version_id}, ${step.id}, ${runId}, ${eventType}, ${correlationKey},
              now() + ${timeoutSeconds ?? null}::int * interval '1 second')
      ON CONFLICT DO NOTHING
    `;
    await tx`UPDATE automation_runs SET status = 'waiting' WHERE id = ${runId}`;
    return {
      status: "waiting",
      expiresAt: await waitExpiry(tx, runId, step.id),
    };
  });
}

/** When the run's wait listener on `stepId` expires; null if it has none or never expires. */
export async function waitExpiry(
  db: Database,
  runId: string,
  stepId: string,
): Promise<Date | null> {
  const [row] = await db<{ expires_at: Date | null }[]>`
    SELECT expires_at FROM automation_triggers WHERE run_id = ${runId} AND step_id = ${stepId}
  `;
  return row?.expires_at ?? null;
}

export const WAIT_TIMED_OUT = { timedOut: true } as const;

/**
 * Ends a wait whose listener has expired: the step run finishes with outcome `timeout`
 * and the run follows `next.timeout`, or completes. The listener is claimed with
 * DELETE ... RETURNING before the run is locked, the same order as resumeRun, so a reply
 * and a timeout can't deadlock and only one of them moves the run on.
 * Returns `early` while the listener hasn't expired yet (the caller retries), and null
 * when there's nothing to expire: a reply or a cancellation got there first.
 */
export async function expireWait(params: {
  runId: string;
  step: Step;
  sequence: number;
}): Promise<
  | { status: "expired"; nextStepId: string | null }
  | { status: "early"; expiresAt: Date }
  | null
> {
  const { runId, step, sequence } = params;
  return getDb().begin(async (tx) => {
    // Joining the step run at `sequence` keeps an old timeout job from expiring a later
    // wait on the same step (a loop): that wait has a different sequence.
    const [claimed] = await tx<{ id: string }[]>`
      DELETE FROM automation_triggers l
      USING automation_step_runs sr
      WHERE l.run_id = ${runId} AND l.step_id = ${step.id} AND l.expires_at <= now()
        AND sr.run_id = l.run_id AND sr.step_id = l.step_id
        AND sr.sequence = ${sequence} AND sr.status = 'waiting'
      RETURNING l.id
    `;
    if (!claimed) {
      const [pending] = await tx<{ expires_at: Date }[]>`
        SELECT l.expires_at FROM automation_triggers l
        JOIN automation_step_runs sr
          ON sr.run_id = l.run_id AND sr.step_id = l.step_id
         AND sr.sequence = ${sequence} AND sr.status = 'waiting'
        WHERE l.run_id = ${runId} AND l.step_id = ${step.id} AND l.expires_at > now()
      `;
      return pending
        ? { status: "early", expiresAt: pending.expires_at }
        : null;
    }
    const run = await lockRun(tx, runId);
    if (run?.status !== "waiting") return null;
    await tx`
      UPDATE automation_step_runs SET
        status = 'succeeded', output = ${WAIT_TIMED_OUT}::jsonb, outcome = 'timeout', finished_at = now()
      WHERE run_id = ${runId} AND sequence = ${sequence}
    `;
    const nextStepId = await advance(
      tx,
      run,
      step.key,
      WAIT_TIMED_OUT,
      step.next.timeout,
    );
    return { status: "expired", nextStepId };
  });
}

/** Records a failed attempt. Upserts because a step can fail before its step run exists. */
export async function failStepRun(params: {
  runId: string;
  stepId: string;
  sequence: number;
  attempt: number;
  error: string;
}): Promise<void> {
  const { runId, stepId, sequence, attempt, error } = params;
  await getDb()`
    INSERT INTO automation_step_runs (run_id, step_id, sequence, status, attempt, error, finished_at)
    VALUES (${runId}, ${stepId}, ${sequence}, 'failed', ${attempt}, ${error}, now())
    ON CONFLICT (run_id, sequence) DO UPDATE SET
      status = 'failed', attempt = EXCLUDED.attempt, error = EXCLUDED.error, finished_at = now()
    WHERE automation_step_runs.status IN ('running', 'failed')
  `;
}

/**
 * The general failure handler, called once a step has failed for good: follows the
 * step's `next.error` branch if it has one, otherwise fails the run.
 * Returns the next step id when the run continues on the error branch.
 */
export async function handleStepFailure(params: {
  runId: string;
  step: Step;
  sequence: number;
  error: string;
}): Promise<string | null> {
  const { runId, step, sequence, error } = params;
  return getDb().begin(async (tx) => {
    const run = await lockRun(tx, runId);
    if (run?.status !== "running") return null;
    const errorKey = step.next.error;
    if (errorKey) {
      await tx`
        UPDATE automation_step_runs SET outcome = 'error'
        WHERE run_id = ${runId} AND sequence = ${sequence}
      `;
      return advance(tx, run, step.key, { error }, errorKey);
    }
    await tx`
      UPDATE automation_runs SET status = 'failed', error = ${error}, finished_at = now(),
        current_step_id = NULL
      WHERE id = ${runId}
    `;
    await tx`DELETE FROM automation_triggers WHERE run_id = ${runId}`;
    return null;
  });
}

export interface ListenerMatch {
  id: string;
  automationId: string;
  versionId: string;
  stepId: string;
  /** Null for entry listeners. */
  runId: string | null;
  stepKey: string;
  stepType: string;
  config: Record<string, unknown>;
  next: Record<string, string>;
  /** For wait listeners: the resolved input of the waiting step run. */
  waitInput: unknown;
}

/**
 * Live listeners for an event: entry listeners of active automations on their current
 * version, and unexpired wait listeners of runs that are still waiting. Oldest first.
 */
export async function findListeners(
  eventType: string,
  keys: string[],
  db: Database = getDb(),
): Promise<ListenerMatch[]> {
  if (keys.length === 0) return [];
  const rows = await db<
    {
      id: string;
      automation_id: string;
      version_id: string;
      step_id: string;
      run_id: string | null;
      key: string;
      step_type: string;
      config: Record<string, unknown>;
      next: Record<string, string>;
      wait_input: unknown;
    }[]
  >`
    SELECT l.id, l.automation_id, l.version_id, l.step_id, l.run_id,
           s.key, s.step_type, s.config, s.next, sr.input AS wait_input
    FROM automation_triggers l
    JOIN automation_steps s ON s.id = l.step_id
    JOIN automations a ON a.id = l.automation_id
    LEFT JOIN automation_runs r ON r.id = l.run_id
    LEFT JOIN automation_step_runs sr
      ON sr.run_id = l.run_id AND sr.step_id = l.step_id AND sr.status = 'waiting'
    WHERE l.event_type = ${eventType}
      AND l.correlation_key IN ${db(keys)}
      AND a.deleted_at IS NULL
      AND (
        (l.run_id IS NULL AND a.active AND a.current_version_id = l.version_id)
        OR (l.run_id IS NOT NULL AND r.status = 'waiting'
            AND (l.expires_at IS NULL OR l.expires_at > now()))
      )
    ORDER BY l.created_at, l.id
  `;
  return rows.map((row) => ({
    id: row.id,
    automationId: row.automation_id,
    versionId: row.version_id,
    stepId: row.step_id,
    runId: row.run_id,
    stepKey: row.key,
    stepType: row.step_type,
    config: row.config,
    next: row.next,
    waitInput: row.wait_input,
  }));
}

/**
 * Resumes a waiting run whose listener matched. The listener is claimed with
 * DELETE ... RETURNING, so of two concurrent matches only one resumes the run.
 * Returns null when someone else claimed it first. Runs in the caller's transaction, which
 * holds the conversation lock (see lockConversations).
 */
export async function resumeRun(
  tx: Database,
  listener: ListenerMatch,
  output: unknown,
): Promise<{
  runId: string;
  nextStepId: string | null;
  sequence: number;
} | null> {
  const [claimed] = await tx<{ run_id: string }[]>`
    DELETE FROM automation_triggers WHERE id = ${listener.id} RETURNING run_id
  `;
  if (!claimed) return null;
  const run = await lockRun(tx, claimed.run_id);
  if (run?.status !== "waiting") return null;
  const [stepRun] = await tx<{ sequence: number }[]>`
    UPDATE automation_step_runs SET
      status = 'succeeded', output = ${output ?? null}::jsonb, outcome = 'ok', finished_at = now()
    WHERE run_id = ${run.id} AND step_id = ${listener.stepId} AND status = 'waiting'
    RETURNING sequence
  `;
  if (!stepRun) return null;
  const nextStepId = await advance(
    tx,
    run,
    listener.stepKey,
    output,
    listener.next.ok,
  );
  return { runId: run.id, nextStepId, sequence: stepRun.sequence + 1 };
}

/**
 * Starts a run from a matched entry listener. Returns null when the subject already has
 * an active run. For a duplicate event (e.g. a retried event job that crashed before
 * enqueueing) it returns the existing run's current step so the caller can re-enqueue it;
 * the step job id makes that idempotent. A run's next sequence is always step_count + 1.
 */
export async function startRun(params: {
  listener: ListenerMatch;
  triggerEventId: string;
  subjectKey: string;
  output: unknown;
}): Promise<{
  runId: string;
  nextStepId: string | null;
  sequence: number;
  duplicate: boolean;
} | null> {
  const { listener, triggerEventId, subjectKey, output } = params;
  return getDb().begin(async (tx) => {
    const [run] = await tx<RunRow[]>`
      INSERT INTO automation_runs (automation_id, version_id, trigger_event_id, subject_key, current_step_id, context)
      VALUES (${listener.automationId}, ${listener.versionId}, ${triggerEventId}, ${subjectKey},
              ${listener.stepId}, ${{ trigger: output, steps: {} }}::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (!run) {
      const [existing] = await tx<RunRow[]>`
        SELECT * FROM automation_runs
        WHERE automation_id = ${listener.automationId} AND trigger_event_id = ${triggerEventId}
      `;
      if (!existing) return null;
      return {
        runId: existing.id,
        nextStepId:
          existing.status === "running" ? existing.current_step_id : null,
        sequence: existing.step_count + 1,
        duplicate: true,
      };
    }
    await tx`
      INSERT INTO automation_step_runs (run_id, step_id, sequence, status, input, output, outcome, finished_at)
      VALUES (${run.id}, ${listener.stepId}, 1, 'succeeded', ${listener.config}::jsonb,
              ${output ?? null}::jsonb, 'ok', now())
    `;
    const nextStepId = await advance(
      tx,
      run,
      listener.stepKey,
      output,
      listener.next.ok,
    );
    return { runId: run.id, nextStepId, sequence: 2, duplicate: false };
  });
}

/** Cancels an automation's running and waiting runs and drops their wait listeners. */
export async function cancelActiveRuns(
  tx: Database,
  automationId: string,
): Promise<void> {
  await tx`
    UPDATE automation_runs SET status = 'cancelled', finished_at = now(), current_step_id = NULL
    WHERE automation_id = ${automationId} AND status IN ('running', 'waiting')
  `;
  await tx`
    DELETE FROM automation_triggers WHERE automation_id = ${automationId} AND run_id IS NOT NULL
  `;
}

// ---- Unmatched events ----

/** How long an unmatched event is kept. The race it covers lasts seconds. */
export const UNMATCHED_EVENT_TTL_HOURS = 24;

/**
 * Serialises everything that touches these conversations (correlation keys) until the
 * transaction ends: an incoming event deciding between "resume a run" and "hold", and a
 * run deciding between "claim a held event" and "start waiting". Without it, each side
 * could miss the other's uncommitted row. Lock order: conversation, then listener, then
 * run row. Keys are sorted so two multi-key callers can't deadlock.
 */
export async function lockConversations(
  tx: Database,
  keys: string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort())
    await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** Stores an event no listener matched, once per key; a retried job inserts nothing. */
export async function holdUnmatchedEvent(
  tx: Database,
  event: SocialEvent,
  keys: string[],
  receivedAt: Date,
): Promise<void> {
  for (const key of keys)
    await tx`
      INSERT INTO automation_unmatched_events (event_type, event_id, correlation_key, event, received_at)
      VALUES (${event.type}, ${event.eventId}, ${key}, ${event}::jsonb, ${receivedAt})
      ON CONFLICT DO NOTHING
    `;
  await tx`
    DELETE FROM automation_unmatched_events
    WHERE received_at < now() - ${UNMATCHED_EVENT_TTL_HOURS}::int * interval '1 hour'
  `;
}

/**
 * Claims the oldest held event that answers a run about to wait at `sequence`: same event
 * type and key, received no earlier than the previous step run started (an older message
 * can't answer a question asked after it), and accepted by `match`. Every row of that
 * event is deleted, so it can't answer two runs.
 */
async function claimUnmatchedEvent(
  tx: Database,
  params: {
    runId: string;
    sequence: number;
    eventType: string;
    correlationKey: string;
    match: (event: SocialEvent) => unknown;
  },
): Promise<{ output: unknown } | null> {
  const { runId, sequence, eventType, correlationKey, match } = params;
  const rows = await tx<{ event_id: string; event: SocialEvent }[]>`
    SELECT e.event_id, e.event FROM automation_unmatched_events e
    WHERE e.event_type = ${eventType} AND e.correlation_key = ${correlationKey}
      AND e.received_at > now() - ${UNMATCHED_EVENT_TTL_HOURS}::int * interval '1 hour'
      AND e.received_at >= (
        SELECT started_at FROM automation_step_runs
        WHERE run_id = ${runId} AND sequence = ${sequence - 1}
      )
    ORDER BY e.received_at, e.event_id
  `;
  for (const row of rows) {
    const output = match(row.event);
    if (output === null) continue;
    await tx`
      DELETE FROM automation_unmatched_events
      WHERE event_type = ${eventType} AND event_id = ${row.event_id}
    `;
    return { output };
  }
  return null;
}

// ---- Read side for the API ----

export interface RunSummary {
  id: string;
  versionId: string;
  status: RunStatus;
  subjectKey: string;
  triggerEventId: string;
  currentStepKey: string | null;
  stepCount: number;
  error: string | null;
  /** When the run's current wait times out; null if it isn't waiting or has no timeout. */
  waitExpiresAt: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StepRunView {
  sequence: number;
  stepKey: string;
  stepType: string;
  status: string;
  attempt: number;
  input: unknown;
  output: unknown;
  outcome: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type RunSummaryRow = RunRow & {
  current_step_key: string | null;
  wait_expires_at: Date | null;
};

const toRunSummary = (row: RunSummaryRow): RunSummary => ({
  id: row.id,
  versionId: row.version_id,
  status: row.status,
  subjectKey: row.subject_key,
  triggerEventId: row.trigger_event_id,
  currentStepKey: row.current_step_key,
  stepCount: row.step_count,
  error: row.error,
  waitExpiresAt: row.wait_expires_at?.toISOString() ?? null,
  startedAt: row.started_at.toISOString(),
  finishedAt: row.finished_at?.toISOString() ?? null,
});

/** Newest first. `before` is a startedAt cursor from the previous page. */
export async function listRuns(
  automationId: string,
  opts: { limit: number; before?: string },
): Promise<RunSummary[]> {
  const before = opts.before ? new Date(opts.before) : new Date("9999-01-01");
  const rows = await getDb()<RunSummaryRow[]>`
    SELECT r.*, s.key AS current_step_key, w.expires_at AS wait_expires_at
    FROM automation_runs r
    LEFT JOIN automation_steps s ON s.id = r.current_step_id
    LEFT JOIN automation_triggers w ON w.run_id = r.id
    WHERE r.automation_id = ${automationId} AND r.started_at < ${before}
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT ${opts.limit}
  `;
  return rows.map(toRunSummary);
}

export async function getRunDetail(
  automationId: string,
  runId: string,
): Promise<RunSummary & { context: RunContext; steps: StepRunView[] }> {
  const [row] = await getDb()<RunSummaryRow[]>`
    SELECT r.*, s.key AS current_step_key, w.expires_at AS wait_expires_at
    FROM automation_runs r
    LEFT JOIN automation_steps s ON s.id = r.current_step_id
    LEFT JOIN automation_triggers w ON w.run_id = r.id
    WHERE r.id = ${runId} AND r.automation_id = ${automationId}
  `;
  if (!row) throw new NotFoundError("Run not found");
  const steps = await getDb()<
    {
      sequence: number;
      key: string;
      step_type: string;
      status: string;
      attempt: number;
      input: unknown;
      output: unknown;
      outcome: string | null;
      error: string | null;
      started_at: Date;
      finished_at: Date | null;
    }[]
  >`
    SELECT sr.sequence, s.key, s.step_type, sr.status, sr.attempt, sr.input, sr.output,
           sr.outcome, sr.error, sr.started_at, sr.finished_at
    FROM automation_step_runs sr
    JOIN automation_steps s ON s.id = sr.step_id
    WHERE sr.run_id = ${runId}
    ORDER BY sr.sequence
  `;
  return {
    ...toRunSummary(row),
    context: row.context,
    steps: steps.map((s) => ({
      sequence: s.sequence,
      stepKey: s.key,
      stepType: s.step_type,
      status: s.status,
      attempt: s.attempt,
      input: s.input,
      output: s.output,
      outcome: s.outcome,
      error: s.error,
      startedAt: s.started_at.toISOString(),
      finishedAt: s.finished_at?.toISOString() ?? null,
    })),
  };
}
