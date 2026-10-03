import { type Database, getDb, isUniqueViolation } from "../db/db";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { cancelActiveRuns, type RunStatus } from "./runs.service";
import { getStepType } from "./steps/registry";
import { type StepDefinition, validateSteps } from "./validation";

/**
 * Automations and their versioned steps. Every query is scoped to the owner; another
 * user's automation looks exactly like a missing one (404).
 *
 * Steps are edited on a draft version. When there is no draft, the first edit copies the
 * published version (copy-on-write). Keys are stable across versions, so nothing needs
 * remapping. Mutations lock the automation row so concurrent edits serialize.
 */

export type StepView = StepDefinition;

export interface AutomationSummary {
  id: string;
  name: string;
  active: boolean;
  publishedVersion: number | null;
  hasDraft: boolean;
  runs: Record<RunStatus, number>;
  createdAt: string;
  updatedAt: string;
}

export interface VersionView {
  version: number;
  publishedAt: string | null;
  steps: StepView[];
}

export interface AutomationDetail extends AutomationSummary {
  draft: VersionView | null;
  published: VersionView | null;
}

interface AutomationRow {
  id: string;
  user_id: string;
  name: string;
  active: boolean;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

type SummaryRow = AutomationRow & {
  published_version: number | null;
  has_draft: boolean;
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
};

interface StepRow {
  key: string;
  step_type: string;
  label: string;
  config: Record<string, unknown>;
  next: Record<string, string>;
}

const toStepView = (row: StepRow): StepView => ({
  key: row.key,
  stepType: row.step_type,
  label: row.label,
  config: row.config,
  next: row.next,
});

const toSummary = (row: SummaryRow): AutomationSummary => ({
  id: row.id,
  name: row.name,
  active: row.active,
  publishedVersion: row.published_version,
  hasDraft: row.has_draft,
  runs: {
    running: Number(row.running),
    waiting: Number(row.waiting),
    completed: Number(row.completed),
    failed: Number(row.failed),
    cancelled: Number(row.cancelled),
  },
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

async function selectSummaries(
  db: Database,
  userId: string,
  automationId?: string,
): Promise<SummaryRow[]> {
  return db<SummaryRow[]>`
    SELECT a.*,
      pv.version AS published_version,
      EXISTS (
        SELECT 1 FROM automation_versions d
        WHERE d.automation_id = a.id AND d.published_at IS NULL
      ) AS has_draft,
      COALESCE(rc.running, 0) AS running, COALESCE(rc.waiting, 0) AS waiting,
      COALESCE(rc.completed, 0) AS completed, COALESCE(rc.failed, 0) AS failed,
      COALESCE(rc.cancelled, 0) AS cancelled
    FROM automations a
    LEFT JOIN automation_versions pv ON pv.id = a.current_version_id
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM automation_runs r WHERE r.automation_id = a.id
    ) rc ON true
    WHERE a.user_id = ${userId} AND a.deleted_at IS NULL
      AND (${automationId ?? null}::uuid IS NULL OR a.id = ${automationId ?? null}::uuid)
    ORDER BY a.created_at DESC, a.id DESC
  `;
}

async function lockOwned(
  tx: Database,
  userId: string,
  automationId: string,
): Promise<AutomationRow> {
  const [row] = await tx<AutomationRow[]>`
    SELECT * FROM automations
    WHERE id = ${automationId} AND user_id = ${userId} AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!row) throw new NotFoundError("Automation not found");
  return row;
}

async function findDraftId(
  tx: Database,
  automationId: string,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM automation_versions
    WHERE automation_id = ${automationId} AND published_at IS NULL
  `;
  return row?.id ?? null;
}

/** Returns the draft version id, creating it from the published version if needed. */
async function ensureDraft(
  tx: Database,
  automation: AutomationRow,
): Promise<string> {
  const existing = await findDraftId(tx, automation.id);
  if (existing) return existing;
  const [draft] = await tx<{ id: string }[]>`
    INSERT INTO automation_versions (automation_id, version)
    SELECT ${automation.id}, COALESCE(MAX(version), 0) + 1
    FROM automation_versions WHERE automation_id = ${automation.id}
    RETURNING id
  `;
  if (!draft)
    throw new Error("INSERT INTO automation_versions returned no row");
  if (automation.current_version_id)
    await tx`
      INSERT INTO automation_steps (version_id, key, step_type, label, config, next)
      SELECT ${draft.id}, key, step_type, label, config, next
      FROM automation_steps WHERE version_id = ${automation.current_version_id}
    `;
  return draft.id;
}

async function selectSteps(
  db: Database,
  versionId: string,
): Promise<StepView[]> {
  const rows = await db<StepRow[]>`
    SELECT key, step_type, label, config, next FROM automation_steps
    WHERE version_id = ${versionId}
    ORDER BY created_at, key
  `;
  return rows.map(toStepView);
}

/**
 * Makes the entry listener match the automation's state: one listener for the current
 * version's entry trigger while active, none otherwise.
 */
async function syncEntryListener(
  tx: Database,
  automationId: string,
): Promise<void> {
  await tx`
    DELETE FROM automation_triggers WHERE automation_id = ${automationId} AND run_id IS NULL
  `;
  const [entry] = await tx<
    {
      version_id: string;
      step_id: string;
      step_type: string;
      config: Record<string, unknown>;
    }[]
  >`
    SELECT v.id AS version_id, s.id AS step_id, s.step_type, s.config
    FROM automations a
    JOIN automation_versions v ON v.id = a.current_version_id
    JOIN automation_steps s ON s.id = v.entry_step_id
    WHERE a.id = ${automationId} AND a.active AND a.deleted_at IS NULL
  `;
  if (!entry) return;
  const trigger = getStepType(entry.step_type);
  if (trigger?.kind !== "trigger")
    throw new Error(`Entry step type ${entry.step_type} is not a trigger`);
  const input = trigger.inputSchema.parse(entry.config);
  await tx`
    INSERT INTO automation_triggers (automation_id, version_id, step_id, event_type, correlation_key)
    VALUES (${automationId}, ${entry.version_id}, ${entry.step_id}, ${trigger.eventType},
            ${trigger.correlationKey(input)})
  `;
}

export async function listAutomations(
  userId: string,
): Promise<AutomationSummary[]> {
  const rows = await selectSummaries(getDb(), userId);
  return rows.map(toSummary);
}

export async function getAutomation(
  userId: string,
  automationId: string,
): Promise<AutomationDetail> {
  const db = getDb();
  const [row] = await selectSummaries(db, userId, automationId);
  if (!row) throw new NotFoundError("Automation not found");
  const versions = await db<
    { id: string; version: number; published_at: Date | null }[]
  >`
    SELECT id, version, published_at FROM automation_versions
    WHERE automation_id = ${automationId}
      AND (published_at IS NULL OR id = ${row.current_version_id})
  `;
  const view = async (v: (typeof versions)[number] | undefined) =>
    v
      ? {
          version: v.version,
          publishedAt: v.published_at?.toISOString() ?? null,
          steps: await selectSteps(db, v.id),
        }
      : null;
  return {
    ...toSummary(row),
    draft: await view(versions.find((v) => v.published_at === null)),
    published: await view(
      versions.find((v) => v.id === row.current_version_id),
    ),
  };
}

/** Throws NotFoundError unless the user owns the (non-deleted) automation. */
export async function assertOwned(
  userId: string,
  automationId: string,
): Promise<void> {
  const [row] = await getDb()`
    SELECT 1 FROM automations
    WHERE id = ${automationId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  if (!row) throw new NotFoundError("Automation not found");
}

export async function createAutomation(
  userId: string,
  name: string,
): Promise<AutomationDetail> {
  const id = await getDb().begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO automations (user_id, name) VALUES (${userId}, ${name}) RETURNING id
    `;
    if (!row) throw new Error("INSERT INTO automations returned no row");
    await tx`INSERT INTO automation_versions (automation_id, version) VALUES (${row.id}, 1)`;
    return row.id;
  });
  return getAutomation(userId, id);
}

export async function updateAutomation(
  userId: string,
  automationId: string,
  patch: { name?: string; active?: boolean },
): Promise<AutomationDetail> {
  await getDb().begin(async (tx) => {
    const automation = await lockOwned(tx, userId, automationId);
    if (patch.active === true && !automation.current_version_id)
      throw new ValidationError("Publish the automation before turning it on");
    await tx`
      UPDATE automations SET
        name = ${patch.name ?? automation.name},
        active = ${patch.active ?? automation.active}
      WHERE id = ${automationId}
    `;
    if (patch.active !== undefined && patch.active !== automation.active) {
      await syncEntryListener(tx, automationId);
      if (!patch.active) await cancelActiveRuns(tx, automationId);
    }
  });
  return getAutomation(userId, automationId);
}

/** Soft delete: turns the automation off, removes its listeners and cancels its runs. */
export async function deleteAutomation(
  userId: string,
  automationId: string,
): Promise<void> {
  await getDb().begin(async (tx) => {
    await lockOwned(tx, userId, automationId);
    await tx`
      UPDATE automations SET deleted_at = now(), active = false WHERE id = ${automationId}
    `;
    await syncEntryListener(tx, automationId);
    await cancelActiveRuns(tx, automationId);
  });
}

/** The draft's steps if there is a draft, otherwise the published version's. */
export async function listSteps(
  userId: string,
  automationId: string,
): Promise<{ version: number | null; isDraft: boolean; steps: StepView[] }> {
  const detail = await getAutomation(userId, automationId);
  const version = detail.draft ?? detail.published;
  return {
    version: version?.version ?? null,
    isDraft: detail.draft !== null,
    steps: version?.steps ?? [],
  };
}

function assertKnownStepType(stepType: string): void {
  if (!getStepType(stepType))
    throw new ValidationError(`Unknown step type '${stepType}'`);
}

export async function addStep(
  userId: string,
  automationId: string,
  step: StepDefinition,
): Promise<StepView> {
  assertKnownStepType(step.stepType);
  try {
    return await getDb().begin(async (tx) => {
      const automation = await lockOwned(tx, userId, automationId);
      const draftId = await ensureDraft(tx, automation);
      const [row] = await tx<StepRow[]>`
        INSERT INTO automation_steps (version_id, key, step_type, label, config, next)
        VALUES (${draftId}, ${step.key}, ${step.stepType}, ${step.label},
                ${step.config}::jsonb, ${step.next}::jsonb)
        RETURNING key, step_type, label, config, next
      `;
      if (!row) throw new Error("INSERT INTO automation_steps returned no row");
      return toStepView(row);
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(`A step with key '${step.key}' already exists`);
    throw error;
  }
}

export async function updateStep(
  userId: string,
  automationId: string,
  key: string,
  patch: Partial<Pick<StepDefinition, "label" | "config" | "next">>,
): Promise<StepView> {
  return getDb().begin(async (tx) => {
    const automation = await lockOwned(tx, userId, automationId);
    const draftId = await ensureDraft(tx, automation);
    const [row] = await tx<StepRow[]>`
      UPDATE automation_steps SET
        label = COALESCE(${patch.label ?? null}, label),
        config = COALESCE(${patch.config ?? null}::jsonb, config),
        next = COALESCE(${patch.next ?? null}::jsonb, next)
      WHERE version_id = ${draftId} AND key = ${key}
      RETURNING key, step_type, label, config, next
    `;
    if (!row) throw new NotFoundError(`Step '${key}' not found`);
    return toStepView(row);
  });
}

/** Other steps' `next` entries pointing at the removed step are left; publish reports them. */
export async function deleteStep(
  userId: string,
  automationId: string,
  key: string,
): Promise<void> {
  await getDb().begin(async (tx) => {
    const automation = await lockOwned(tx, userId, automationId);
    const draftId = await ensureDraft(tx, automation);
    const [row] = await tx`
      DELETE FROM automation_steps WHERE version_id = ${draftId} AND key = ${key} RETURNING id
    `;
    if (!row) throw new NotFoundError(`Step '${key}' not found`);
  });
}

export async function discardDraft(
  userId: string,
  automationId: string,
): Promise<void> {
  await getDb().begin(async (tx) => {
    await lockOwned(tx, userId, automationId);
    const [row] = await tx`
      DELETE FROM automation_versions
      WHERE automation_id = ${automationId} AND published_at IS NULL
      RETURNING id
    `;
    if (!row) throw new NotFoundError("There is no draft");
  });
}

/**
 * Validates the draft and makes it the current version. Runs already in progress keep
 * their pinned version; only the entry listener moves to the new one.
 */
export async function publishAutomation(
  userId: string,
  automationId: string,
): Promise<AutomationDetail> {
  await getDb().begin(async (tx) => {
    await lockOwned(tx, userId, automationId);
    const draftId = await findDraftId(tx, automationId);
    if (!draftId) throw new ValidationError("There are no changes to publish");

    const steps = await selectSteps(tx, draftId);
    const { problems, entryKey } = validateSteps(steps);
    if (problems.length > 0 || !entryKey)
      throw new ValidationError("The automation can't be published", problems);

    await tx`
      UPDATE automation_versions SET
        published_at = now(),
        entry_step_id = (
          SELECT id FROM automation_steps WHERE version_id = ${draftId} AND key = ${entryKey}
        )
      WHERE id = ${draftId}
    `;
    await tx`UPDATE automations SET current_version_id = ${draftId} WHERE id = ${automationId}`;
    await syncEntryListener(tx, automationId);
  });
  return getAutomation(userId, automationId);
}
