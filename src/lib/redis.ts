import type { ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { getConfig } from "../config/config";
import { logger } from "./logger";

const PING_TIMEOUT_MS = 2000;

let connection: Redis | undefined;

/**
 * Shared, lazily-created ioredis client used by every BullMQ Queue/Worker.
 * `maxRetriesPerRequest: null` is required by BullMQ workers (blocking commands).
 * Workers duplicate this connection internally; queues share it.
 */
export function getRedisConnection(): ConnectionOptions {
  return getRedisClient() as unknown as ConnectionOptions;
}

export function getRedisClient(): Redis {
  if (!connection) {
    connection = new Redis(getConfig().REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    connection.on("error", (error) => {
      logger.error({
        event: "redis_error",
        source: "redis",
        error: error.message,
      });
    });
  }
  return connection;
}

/** PING with a timeout — with maxRetriesPerRequest: null a plain ping would wait forever while Redis is down. */
async function pingWithTimeout(timeoutMs = PING_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis ping timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([getRedisClient().ping(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function testRedisConnectionOnStartup(): Promise<void> {
  try {
    await pingWithTimeout(5000);
    logger.info({ event: "redis_connected", source: "redis" });
  } catch (error) {
    logger.error({
      event: "redis_connection_failed",
      source: "redis",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

export async function redisHealthCheck(): Promise<boolean> {
  try {
    await pingWithTimeout();
    return true;
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (!connection) return;
  const client = connection;
  connection = undefined;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
