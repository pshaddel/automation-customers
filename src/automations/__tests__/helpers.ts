import { mock } from "bun:test";
import type { Job } from "bullmq";
import { Redis } from "ioredis";
import { getDb, initDb } from "../../db/db";
import { runMigrations } from "../../db/migrate";
import type { SocialMediaClient } from "../../social-media/social-media.client";
import { createUser } from "../../users/users.service";

/** Connects and migrates the dev database; false when Postgres is unreachable. */
export async function prepareDb(label: string): Promise<boolean> {
  try {
    initDb(process.env.DATABASE_URL ?? "");
    await runMigrations();
    return true;
  } catch {
    console.warn(`[${label}] Postgres unavailable; skipping integration tests`);
    return false;
  }
}

export async function redisReachable(url: string): Promise<boolean> {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

export const uniqueId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/** Test users get a `t_` prefix; pass the returned ids to `deleteUsers` in afterAll. */
export async function createTestUser(): Promise<string> {
  const user = await createUser({
    username: uniqueId("t"),
    name: "Test User",
    password: "correct-horse-battery",
  });
  return user.id;
}

/** Hard delete; automations, versions, steps, runs and listeners cascade. */
export async function deleteUsers(ids: string[]): Promise<void> {
  for (const id of ids) await getDb()`DELETE FROM users WHERE id = ${id}`;
}

export function fakeJob<T>(data: T, attemptsMade = 0, attempts = 3): Job<T> {
  return { data, attemptsMade, opts: { attempts } } as unknown as Job<T>;
}

export function fakeSocialMedia() {
  const sendDm = mock(async (p: { idempotencyKey: string }) => ({
    messageId: `msg_${p.idempotencyKey}`,
  }));
  const commentOnPost = mock(async (p: { idempotencyKey: string }) => ({
    replyId: `reply_${p.idempotencyKey}`,
  }));
  const client = { sendDm, commentOnPost } as unknown as SocialMediaClient;
  return { client, sendDm, commentOnPost };
}
