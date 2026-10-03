import { Elysia, t } from "elysia";
import { dbHealthCheck } from "../db/db";
import { redisHealthCheck } from "../lib/redis";

const healthSchema = t.Object({
  status: t.Union([t.Literal("ok"), t.Literal("degraded")]),
  db: t.Boolean(),
  redis: t.Boolean(),
});

export function healthModule() {
  return new Elysia({ prefix: "/api", detail: { tags: ["Health"] } }).get(
    "/health",
    async ({ status }) => {
      const [db, redis] = await Promise.all([
        dbHealthCheck(),
        redisHealthCheck(),
      ]);
      if (db && redis) return { status: "ok" as const, db, redis };
      return status(503, { status: "degraded" as const, db, redis });
    },
    {
      response: { 200: healthSchema, 503: healthSchema },
      detail: { summary: "Liveness/readiness of the API and its dependencies" },
    },
  );
}
