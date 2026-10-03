import { createQueue } from "../lib/queue";

export const EXAMPLE_QUEUE = "example";

export interface ExampleJobData {
  userId: string;
  message: string;
}

export function getExampleQueue() {
  return createQueue<ExampleJobData>(EXAMPLE_QUEUE);
}

/** Enqueue an example job. Pass `jobId` to make the enqueue idempotent. Returns the job id. */
export async function enqueueExample(
  data: ExampleJobData,
  jobId?: string,
): Promise<string> {
  const job = await getExampleQueue().add(
    EXAMPLE_QUEUE,
    data,
    jobId ? { jobId } : undefined,
  );
  if (!job.id) throw new Error("BullMQ did not assign a job id");
  return job.id;
}
