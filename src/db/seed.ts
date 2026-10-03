/**
 * Seed runner.
 *
 * Discovers every `*.seed.ts` file under `src/` (e.g. `src/users/users.seed.ts`),
 * imports it, and runs the seeds sorted by `order`, then by path.
 *
 * Seed module contract (see {@link SeedModule}):
 *
 *   import type { Database } from "../db/db";
 *   export const order = 10;
 *   export async function run(db: Database): Promise<void> { ... }
 *
 * IMPORTANT: seeds MUST be idempotent. `db:seed` and `db:reset` may run them
 * any number of times against a populated database, so use
 * `INSERT ... ON CONFLICT DO NOTHING / DO UPDATE` or existence checks.
 */
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { logger } from "../lib/logger";
import { closeDb, type Database, getDb, initDb } from "./db";

export interface SeedModule {
  /** Lower runs first; ties are broken by file path. */
  order: number;
  /** Must be idempotent. */
  run(db: Database): Promise<void>;
}

export const SEEDS_ROOT = join(import.meta.dir, "..");

function isSeedModule(mod: unknown): mod is SeedModule {
  const m = mod as Partial<SeedModule> | null;
  return !!m && typeof m.order === "number" && typeof m.run === "function";
}

export async function runSeeds(
  db: Database = getDb(),
  root: string = SEEDS_ROOT,
): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.seed.ts").scan({ cwd: root, onlyFiles: true }),
  );

  const seeds: { file: string; mod: SeedModule }[] = [];
  for (const file of files) {
    const mod: unknown = await import(join(root, file));
    if (!isSeedModule(mod)) {
      throw new Error(
        `Seed ${file} must export \`order: number\` and \`run(db)\``,
      );
    }
    seeds.push({ file, mod });
  }
  seeds.sort(
    (a, b) => a.mod.order - b.mod.order || a.file.localeCompare(b.file),
  );

  for (const { file, mod } of seeds) {
    await mod.run(db);
    logger.info({ event: "seed_ran", source: "seed", file });
  }
  if (seeds.length === 0)
    logger.info({ event: "no_seeds_found", source: "seed" });
  return seeds.map((s) => s.file);
}

if (import.meta.main) {
  try {
    const config = loadConfig();
    initDb(config.DATABASE_URL);
    await runSeeds();
    await closeDb();
  } catch (error) {
    logger.error({
      event: "seed_failed",
      source: "seed",
      error: String(error),
    });
    await closeDb().catch(() => {});
    process.exit(1);
  }
}
