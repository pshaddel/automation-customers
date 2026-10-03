import { type DefaultJobOptions, Queue } from "bullmq";
import { getRedisConnection } from "./redis";

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 60 * 60, count: 1000 }, // keep completed jobs 1h so status can be polled
  removeOnFail: { age: 7 * 24 * 60 * 60 }, // keep failed jobs for 7 days
} satisfies DefaultJobOptions;

const queues = new Map<string, Queue>();

/**
 * Returns the typed BullMQ queue for `name`, creating it on first use with the
 * shared Redis connection and DEFAULT_JOB_OPTIONS. Every created queue is tracked
 * so `closeQueues()` can close them all on shutdown.
 */
export function createQueue<TData, TResult = void>(
  name: string,
): Queue<TData, TResult> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<TData, TResult>;

  const queue = new Queue<TData, TResult>(name, {
    connection: getRedisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queues.set(name, queue as Queue);
  return queue;
}

export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.all(all.map((queue) => queue.close()));
}
