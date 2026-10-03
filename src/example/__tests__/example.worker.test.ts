import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "../../config/config";
import { closeQueues, createQueue } from "../../lib/queue";
import { closeRedis, getRedisConnection } from "../../lib/redis";
import type { ExampleJobData } from "../example.queue";
import { startExampleWorker } from "../example.worker";

const config = loadConfig();

async function redisReachable(url: string): Promise<boolean> {
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

const reachable = await redisReachable(config.REDIS_URL);
if (!reachable)
  console.warn(
    `[example.worker.test] Redis unreachable at ${config.REDIS_URL}; skipping`,
  );

// Unique queue per run so we never touch the real "example" queue's jobs.
const queueName = `example-test-${crypto.randomUUID()}`;

describe.skipIf(!reachable)("example worker (integration)", () => {
  let worker: ReturnType<typeof startExampleWorker>;
  let queueEvents: QueueEvents;
  const queue = reachable ? createQueue<ExampleJobData>(queueName) : undefined;

  beforeAll(async () => {
    worker = startExampleWorker({ queueName });
    queueEvents = new QueueEvents(queueName, {
      connection: getRedisConnection(),
    });
    await Promise.all([worker.waitUntilReady(), queueEvents.waitUntilReady()]);
  });

  afterAll(async () => {
    await worker?.close();
    await queueEvents?.close();
    await queue?.obliterate({ force: true });
    await closeQueues();
    await closeRedis();
  });

  test("processes a job to completion with progress", async () => {
    if (!queue) throw new Error("queue not created");
    const progress: unknown[] = [];
    const onProgress = ({ jobId, data }: { jobId: string; data: unknown }) => {
      if (jobId === "job-1") progress.push(data);
    };
    queueEvents.on("progress", onProgress);
    const job = await queue.add(
      "example",
      { userId: "user-1", message: "hello" },
      { jobId: "job-1" },
    );

    await job.waitUntilFinished(queueEvents, 10_000);
    queueEvents.off("progress", onProgress);

    expect(progress.at(-1)).toBe(100);

    expect(await queue.getJob("job-1").then((j) => j?.getState())).toBe(
      "completed",
    );
  });

  test("same jobId is idempotent while the job exists", async () => {
    if (!queue) throw new Error("queue not created");
    await worker.pause();
    const a = await queue.add(
      "example",
      { userId: "u", message: "m" },
      { jobId: "dup" },
    );
    const b = await queue.add(
      "example",
      { userId: "u", message: "m" },
      { jobId: "dup" },
    );
    expect(a.id).toBe("dup");
    expect(b.id).toBe("dup");
    expect(await queue.getWaitingCount()).toBe(1);
    worker.resume();
    await a.waitUntilFinished(queueEvents, 10_000);
  });
});
