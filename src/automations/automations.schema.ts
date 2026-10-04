import { t } from "elysia";

export const automationIdParams = t.Object({
  id: t.String({ format: "uuid" }),
});

export const stepKeyParams = t.Object({
  id: t.String({ format: "uuid" }),
  key: t.String({ minLength: 1 }),
});

export const runParams = t.Object({
  id: t.String({ format: "uuid" }),
  runId: t.String({ format: "uuid" }),
});

const stepKey = t.String({
  pattern: "^[a-z][a-z0-9_]*$",
  maxLength: 64,
  description: "Stable id within the automation, e.g. `ask`",
});

const config = t.Record(t.String(), t.Unknown(), {
  description:
    "Step settings; string values may use {{trigger.*}} / {{steps.<key>.*}}",
});

const next = t.Record(t.String(), t.String(), {
  description: "Outcome → step key, e.g. { ok: 'ask' }",
});

export const stepSchema = t.Object({
  key: t.String(),
  stepType: t.String(),
  label: t.String(),
  config,
  next,
});

export const createStepBody = t.Object({
  key: stepKey,
  stepType: t.String({ minLength: 1 }),
  label: t.String({ minLength: 1, maxLength: 200 }),
  config: t.Optional(config),
  next: t.Optional(next),
});

export const updateStepBody = t.Object({
  label: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  config: t.Optional(config),
  next: t.Optional(next),
});

export const createAutomationBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
});

export const updateAutomationBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  active: t.Optional(t.Boolean()),
});

const runCounts = t.Object({
  running: t.Number(),
  waiting: t.Number(),
  completed: t.Number(),
  failed: t.Number(),
  cancelled: t.Number(),
});

export const automationSummarySchema = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  active: t.Boolean(),
  publishedVersion: t.Nullable(t.Number()),
  hasDraft: t.Boolean(),
  runs: runCounts,
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

const versionSchema = t.Object({
  version: t.Number(),
  publishedAt: t.Nullable(t.String({ format: "date-time" })),
  steps: t.Array(stepSchema),
});

export const automationDetailSchema = t.Composite([
  automationSummarySchema,
  t.Object({
    draft: t.Nullable(versionSchema),
    published: t.Nullable(versionSchema),
  }),
]);

export const stepListSchema = t.Object({
  version: t.Nullable(t.Number()),
  isDraft: t.Boolean(),
  steps: t.Array(stepSchema),
});

export const stepTypeSchema = t.Object({
  type: t.String(),
  kind: t.Union([t.Literal("action"), t.Literal("trigger")]),
  description: t.String(),
  outcomes: t.Array(t.String()),
  position: t.Optional(t.Union([t.Literal("entry"), t.Literal("wait")])),
  eventType: t.Optional(t.String()),
  inputSchema: t.Unknown({ description: "JSON Schema of the step's config" }),
});

const runStatus = t.Union([
  t.Literal("running"),
  t.Literal("waiting"),
  t.Literal("completed"),
  t.Literal("failed"),
  t.Literal("cancelled"),
]);

export const runSummarySchema = t.Object({
  id: t.String({ format: "uuid" }),
  versionId: t.String({ format: "uuid" }),
  status: runStatus,
  subjectKey: t.String(),
  triggerEventId: t.String(),
  currentStepKey: t.Nullable(t.String()),
  stepCount: t.Number(),
  error: t.Nullable(t.String()),
  waitExpiresAt: t.Nullable(t.String({ format: "date-time" })),
  startedAt: t.String({ format: "date-time" }),
  finishedAt: t.Nullable(t.String({ format: "date-time" })),
});

export const runDetailSchema = t.Composite([
  runSummarySchema,
  t.Object({
    context: t.Unknown(),
    steps: t.Array(
      t.Object({
        sequence: t.Number(),
        stepKey: t.String(),
        stepType: t.String(),
        status: t.String(),
        attempt: t.Number(),
        input: t.Unknown(),
        output: t.Unknown(),
        outcome: t.Nullable(t.String()),
        error: t.Nullable(t.String()),
        startedAt: t.String({ format: "date-time" }),
        finishedAt: t.Nullable(t.String({ format: "date-time" })),
      }),
    ),
  }),
]);

export const listRunsQuery = t.Object({
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 })),
  before: t.Optional(t.String({ format: "date-time" })),
});

export const validationErrorSchema = t.Object({
  error: t.String(),
  message: t.String(),
  details: t.Optional(
    t.Array(t.Object({ stepKey: t.Optional(t.String()), problem: t.String() })),
  ),
});
