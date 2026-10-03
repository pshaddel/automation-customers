import { Elysia, t } from "elysia";
import { authPlugin } from "../auth/auth.plugin";
import { NotFoundError } from "../lib/errors";
import { enqueueExample, getExampleQueue } from "./example.queue";

export function exampleModule() {
  return new Elysia({ prefix: "/api/example", detail: { tags: ["Example"] } })
    .use(authPlugin)
    .post(
      "/jobs",
      async ({ body, user }) => {
        const jobId = await enqueueExample({
          userId: user.id,
          message: body.message,
        });
        return { jobId };
      },
      {
        auth: true,
        body: t.Object({ message: t.String({ minLength: 1 }) }),
        detail: { summary: "Enqueue an example background job" },
      },
    )
    .get(
      "/jobs/:id",
      async ({ params, user }) => {
        const job = await getExampleQueue().getJob(params.id);
        // Hide other users' jobs behind the same 404 as missing ones.
        if (!job || job.data.userId !== user.id)
          throw new NotFoundError("Job not found");
        return {
          id: params.id,
          state: await job.getState(),
          progress: job.progress,
          returnvalue: job.returnvalue ?? null,
          failedReason: job.failedReason ?? null,
          attemptsMade: job.attemptsMade,
        };
      },
      {
        auth: true,
        params: t.Object({ id: t.String() }),
        detail: { summary: "Get an example job's status" },
      },
    );
}
