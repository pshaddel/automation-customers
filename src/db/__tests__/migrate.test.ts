import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import type { Database } from "../db";
import { runMigrations } from "../migrate";

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5491/automation";
const schema = `mig_test_${process.pid}_${Date.now()}`;

async function pgReachable(): Promise<boolean> {
  const probe = new SQL({ url, max: 1, connectionTimeout: 2 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => {});
  }
}

const reachable = await pgReachable();

describe.skipIf(!reachable)("runMigrations", () => {
  let admin: Database;
  let db: Database;
  let dir: string;

  async function tableExists(name: string): Promise<boolean> {
    const [row] =
      await admin`SELECT to_regclass(${`${schema}.${name}`}) IS NOT NULL AS exists`;
    return row.exists;
  }

  beforeAll(async () => {
    admin = new SQL({ url, max: 1 });
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    // Every pooled connection gets search_path set at startup, so the runner's
    // unqualified table names (including _migrations) land in the test schema.
    db = new SQL({ url, max: 3, connection: { search_path: schema } });

    dir = await mkdtemp(join(tmpdir(), "migrate-test-"));
    // Written out of order on purpose; 002 depends on 001.
    await writeFile(
      join(dir, "002_add_b.sql"),
      "CREATE TABLE b (id int REFERENCES a(id));",
    );
    await writeFile(
      join(dir, "001_create_a.sql"),
      "CREATE TABLE a (id int PRIMARY KEY);\nINSERT INTO a VALUES (1);",
    );
  });

  afterAll(async () => {
    await db?.close();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("applies migrations in filename order", async () => {
    const applied = await runMigrations(db, dir);
    expect(applied).toEqual(["001_create_a.sql", "002_add_b.sql"]);

    const rows = await db`SELECT name FROM _migrations ORDER BY id`;
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      "001_create_a.sql",
      "002_add_b.sql",
    ]);
    expect(await tableExists("a")).toBe(true);
    expect(await tableExists("b")).toBe(true);
  });

  test("second run applies nothing", async () => {
    expect(await runMigrations(db, dir)).toEqual([]);
    const [row] = await db`SELECT count(*)::int AS n FROM _migrations`;
    expect(row.n).toBe(2);
  });

  test("a failing migration rolls back fully and is not recorded", async () => {
    await writeFile(
      join(dir, "003_broken.sql"),
      "CREATE TABLE c (id int);\nINSERT INTO c VALUES (1);\nSELECT this_function_does_not_exist();",
    );
    await expect(runMigrations(db, dir)).rejects.toThrow(
      "this_function_does_not_exist",
    );

    expect(await tableExists("c")).toBe(false);
    const rows =
      await db`SELECT name FROM _migrations WHERE name = '003_broken.sql'`;
    expect(rows.length).toBe(0);

    // The lock must have been released: a fixed migration applies afterwards.
    await writeFile(join(dir, "003_broken.sql"), "CREATE TABLE c (id int);");
    expect(await runMigrations(db, dir)).toEqual(["003_broken.sql"]);
    expect(await tableExists("c")).toBe(true);
  });

  test("concurrent runners do not race", async () => {
    await writeFile(join(dir, "004_d.sql"), "CREATE TABLE d (id int);");
    const other = new SQL({ url, max: 3, connection: { search_path: schema } });
    try {
      const results = await Promise.all([
        runMigrations(db, dir),
        runMigrations(other, dir),
      ]);
      expect(results.flat()).toEqual(["004_d.sql"]);
    } finally {
      await other.close();
    }
  });
});
