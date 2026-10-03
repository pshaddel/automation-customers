import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { staticPlugin } from "@elysiajs/static";
import { Elysia } from "elysia";
import { authModule } from "./auth/auth.route";
import { automationsModule } from "./automations/automations.route";
import { loadConfig } from "./config/config";
import { closeDb, initDb, testDbConnectionOnStartup } from "./db/db";
import { runMigrations } from "./db/migrate";
import { exampleModule } from "./example/example.route";
import { healthModule } from "./health/health.route";
import { errorHandling } from "./lib/error-handling";
import { logger } from "./lib/logger";
import { closeQueues } from "./lib/queue";
import { closeRedis, testRedisConnectionOnStartup } from "./lib/redis";
import { webhooksModule } from "./social-media/webhooks.route";
import { usersModule } from "./users/users.route";
import { startWorkers } from "./workers";

const config = loadConfig();

initDb(config.DATABASE_URL);
await testDbConnectionOnStartup();
await runMigrations();
await testRedisConnectionOnStartup();

const workers = config.RUN_WORKERS_IN_PROCESS ? startWorkers() : undefined;

const app = new Elysia()
  .use(cors({ credentials: true }))
  .use(
    openapi({
      documentation: {
        info: { title: "Automation Customers API", version: "0.1.0" },
        components: {
          securitySchemes: {
            cookieAuth: { type: "apiKey", in: "cookie", name: "sid" },
          },
        },
      },
    }),
  )
  .use(errorHandling)
  .use(healthModule())
  .use(authModule())
  .use(usersModule())
  .use(exampleModule())
  .use(automationsModule())
  .use(webhooksModule())
  .use(
    await staticPlugin({
      assets: "public",
      prefix: "/public",
      detail: { hide: true },
    }),
  )
  .get("/", () => Bun.file("public/index.html"), { detail: { hide: true } })
  .listen(config.PORT);

logger.info({
  event: "server_started",
  source: "server",
  url: `http://localhost:${config.PORT}`,
  workersInProcess: config.RUN_WORKERS_IN_PROCESS,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "server_shutdown", source: "server", signal });
  await app.stop();
  if (workers) {
    await workers.closeAll();
  } else {
    await closeQueues();
    await closeRedis();
  }
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export type App = typeof app;
