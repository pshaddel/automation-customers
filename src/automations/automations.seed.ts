import type { Database } from "../db/db";
import { logger } from "../lib/logger";
import {
  addStep,
  createAutomation,
  publishAutomation,
  updateAutomation,
} from "./automations.service";
import { pricingExampleSteps } from "./pricing-example";

export const order = 20; // after users (10)

const OWNER = "alice";
const NAME = "Pricing DM (demo)";
export const DEMO_ACCOUNT_ID = "acc_demo";

/**
 * The brief's automation for the demo user, published and on. Re-created on every run:
 * an existing demo automation is hard-deleted first (its versions, steps, runs and
 * listeners cascade), so the seed always leaves exactly one fresh copy. The service
 * functions use the initialized pool (getDb), the same database the runner passes in.
 */
export async function run(db: Database): Promise<void> {
  const [owner] = await db<{ id: string }[]>`
    SELECT id FROM users WHERE username = ${OWNER} AND deleted_at IS NULL
  `;
  if (!owner) {
    logger.info({ event: "seed_automation_skipped", reason: "no demo user" });
    return;
  }
  const removed = await db`
    DELETE FROM automations WHERE user_id = ${owner.id} AND name = ${NAME} RETURNING id
  `;
  if (removed.length > 0)
    logger.info({ event: "seed_automation_removed", count: removed.length });

  const automation = await createAutomation(owner.id, NAME);
  for (const step of pricingExampleSteps(DEMO_ACCOUNT_ID))
    await addStep(owner.id, automation.id, step);
  await publishAutomation(owner.id, automation.id);
  await updateAutomation(owner.id, automation.id, { active: true });
  logger.info({
    event: "seed_automation_created",
    automationId: automation.id,
    accountId: DEMO_ACCOUNT_ID,
  });
}
