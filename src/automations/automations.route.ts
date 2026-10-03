import { Elysia, t } from "elysia";
import { z } from "zod";
import { authPlugin, unauthorizedSchema } from "../auth/auth.plugin";
import { errorSchema } from "../users/users.schema";
import {
  automationDetailSchema,
  automationIdParams,
  automationSummarySchema,
  createAutomationBody,
  createStepBody,
  listRunsQuery,
  runDetailSchema,
  runParams,
  runSummarySchema,
  stepKeyParams,
  stepListSchema,
  stepSchema,
  stepTypeSchema,
  updateAutomationBody,
  updateStepBody,
  validationErrorSchema,
} from "./automations.schema";
import {
  addStep,
  assertOwned,
  createAutomation,
  deleteAutomation,
  deleteStep,
  discardDraft,
  getAutomation,
  listAutomations,
  listSteps,
  publishAutomation,
  updateAutomation,
  updateStep,
} from "./automations.service";
import { getRunDetail, listRuns } from "./runs.service";
import { listStepTypes } from "./steps/registry";

const errors = {
  401: unauthorizedSchema,
  404: errorSchema,
};

export function automationsModule() {
  return new Elysia({
    prefix: "/api/automations",
    detail: { tags: ["Automations"] },
  })
    .use(authPlugin)
    .get(
      "/step-types",
      () =>
        listStepTypes().map((step) => ({
          type: step.type,
          kind: step.kind,
          description: step.description,
          outcomes: [...step.outcomes],
          ...(step.kind === "trigger"
            ? { position: step.position, eventType: step.eventType }
            : {}),
          inputSchema: z.toJSONSchema(step.inputSchema, { io: "input" }),
        })),
      {
        auth: true,
        response: { 200: t.Array(stepTypeSchema), 401: unauthorizedSchema },
        detail: { summary: "Available step types and their config schemas" },
      },
    )
    .get("", ({ user }) => listAutomations(user.id), {
      auth: true,
      response: {
        200: t.Array(automationSummarySchema),
        401: unauthorizedSchema,
      },
      detail: { summary: "List my automations" },
    })
    .post(
      "",
      ({ user, body, status }) =>
        createAutomation(user.id, body.name).then((a) => status(201, a)),
      {
        auth: true,
        body: createAutomationBody,
        response: { 201: automationDetailSchema, 401: unauthorizedSchema },
        detail: {
          summary: "Create an automation (inactive, with an empty draft)",
        },
      },
    )
    .get("/:id", ({ user, params }) => getAutomation(user.id, params.id), {
      auth: true,
      params: automationIdParams,
      response: { 200: automationDetailSchema, ...errors },
      detail: {
        summary: "Get an automation with its draft and published steps",
      },
    })
    .patch(
      "/:id",
      ({ user, params, body }) => updateAutomation(user.id, params.id, body),
      {
        auth: true,
        params: automationIdParams,
        body: updateAutomationBody,
        response: {
          200: automationDetailSchema,
          400: validationErrorSchema,
          ...errors,
        },
        detail: {
          summary:
            "Rename, or turn on/off (off cancels running and waiting runs)",
        },
      },
    )
    .delete(
      "/:id",
      async ({ user, params, status }) => {
        await deleteAutomation(user.id, params.id);
        return status(204, undefined);
      },
      {
        auth: true,
        params: automationIdParams,
        response: { 204: t.Void(), ...errors },
        detail: {
          summary: "Delete an automation (soft delete; cancels its runs)",
        },
      },
    )
    .post(
      "/:id/publish",
      ({ user, params }) => publishAutomation(user.id, params.id),
      {
        auth: true,
        params: automationIdParams,
        response: {
          200: automationDetailSchema,
          400: validationErrorSchema,
          ...errors,
        },
        detail: { summary: "Validate and publish the draft" },
      },
    )
    .delete(
      "/:id/draft",
      async ({ user, params, status }) => {
        await discardDraft(user.id, params.id);
        return status(204, undefined);
      },
      {
        auth: true,
        params: automationIdParams,
        response: { 204: t.Void(), ...errors },
        detail: { summary: "Discard unpublished changes" },
      },
    )
    .get("/:id/steps", ({ user, params }) => listSteps(user.id, params.id), {
      auth: true,
      params: automationIdParams,
      response: { 200: stepListSchema, ...errors },
      detail: { summary: "Steps of the draft, or of the published version" },
    })
    .post(
      "/:id/steps",
      ({ user, params, body, status }) =>
        addStep(user.id, params.id, {
          key: body.key,
          stepType: body.stepType,
          label: body.label,
          config: body.config ?? {},
          next: body.next ?? {},
        }).then((step) => status(201, step)),
      {
        auth: true,
        params: automationIdParams,
        body: createStepBody,
        response: {
          201: stepSchema,
          400: validationErrorSchema,
          409: errorSchema,
          ...errors,
        },
        detail: { summary: "Add a step to the draft" },
      },
    )
    .patch(
      "/:id/steps/:key",
      ({ user, params, body }) =>
        updateStep(user.id, params.id, params.key, body),
      {
        auth: true,
        params: stepKeyParams,
        body: updateStepBody,
        response: { 200: stepSchema, ...errors },
        detail: { summary: "Edit a step in the draft (the key can't change)" },
      },
    )
    .delete(
      "/:id/steps/:key",
      async ({ user, params, status }) => {
        await deleteStep(user.id, params.id, params.key);
        return status(204, undefined);
      },
      {
        auth: true,
        params: stepKeyParams,
        response: { 204: t.Void(), ...errors },
        detail: { summary: "Remove a step from the draft" },
      },
    )
    .get(
      "/:id/runs",
      async ({ user, params, query }) => {
        await assertOwned(user.id, params.id);
        return listRuns(params.id, {
          limit: query.limit ?? 20,
          before: query.before,
        });
      },
      {
        auth: true,
        params: automationIdParams,
        query: listRunsQuery,
        response: { 200: t.Array(runSummarySchema), ...errors },
        detail: { summary: "Runs of an automation, newest first" },
      },
    )
    .get(
      "/:id/runs/:runId",
      async ({ user, params }) => {
        await assertOwned(user.id, params.id);
        return getRunDetail(params.id, params.runId);
      },
      {
        auth: true,
        params: runParams,
        response: { 200: runDetailSchema, ...errors },
        detail: { summary: "One run with its step runs" },
      },
    );
}
