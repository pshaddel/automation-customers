import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default("redis://localhost:6391"),
  RUN_WORKERS_IN_PROCESS: booleanFromString,
  PRETTY_LOGS: booleanFromString,
});

export type Env = z.infer<typeof envSchema>;
