import type { Database } from "../db/db";
import { logger } from "../lib/logger";
import { createUser, usernameExists } from "./users.service";

export const order = 10;

const DEMO_PASSWORD = "Password123!";

const demoUsers = [
  { username: "alice", name: "Alice Anderson" },
  { username: "bob", name: "Bob Brown" },
  { username: "carol", name: "Carol Clark" },
];

/** Idempotent: skips usernames that already exist (including soft-deleted ones). */
export async function run(db: Database): Promise<void> {
  for (const demo of demoUsers) {
    if (await usernameExists(demo.username, db)) {
      logger.info({ event: "seed_user_skipped", username: demo.username });
      continue;
    }
    await createUser({ ...demo, password: DEMO_PASSWORD }, db);
    logger.info({ event: "seed_user_created", username: demo.username });
  }
}
