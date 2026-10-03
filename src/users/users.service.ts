import { type Database, getDb } from "../db/db";
import { NotFoundError } from "../lib/errors";

/**
 * Users domain. The dependency points one way: auth.service -> users.service.
 * Password hashing lives here because createUser (used by sign-up and the seed)
 * owns the password_hash column; auth.service re-exports the helpers.
 */

export type PublicUser = {
  id: string;
  username: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type UserRow = {
  id: string;
  username: string;
  name: string;
  created_at: Date;
  updated_at: Date;
};

type CredentialsRow = UserRow & { password_hash: string };

export type CreateUserInput = {
  username: string;
  name: string;
  password: string;
};

const PASSWORD_OPTIONS = { algorithm: "argon2id" } as const;

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, PASSWORD_OPTIONS);
}

export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Inserts a user. Throws the raw Postgres unique violation (23505) on duplicate username. */
export async function createUser(
  input: CreateUserInput,
  db: Database = getDb(),
): Promise<PublicUser> {
  const passwordHash = await hashPassword(input.password);
  const [row] = await db<UserRow[]>`
    INSERT INTO users (username, name, password_hash)
    VALUES (${input.username}, ${input.name}, ${passwordHash})
    RETURNING id, username, name, created_at, updated_at
  `;
  if (!row) throw new Error("INSERT INTO users returned no row");
  return toPublicUser(row);
}

/** Active (non-deleted) user with password hash, for sign-in. */
export async function findActiveUserCredentials(
  username: string,
): Promise<(PublicUser & { passwordHash: string }) | null> {
  const [row] = await getDb()<CredentialsRow[]>`
    SELECT id, username, name, password_hash, created_at, updated_at
    FROM users
    WHERE username = ${username} AND deleted_at IS NULL
  `;
  return row ? { ...toPublicUser(row), passwordHash: row.password_hash } : null;
}

export async function usernameExists(
  username: string,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM users WHERE username = ${username}) AS exists
  `;
  return row?.exists ?? false;
}

export async function getUserById(id: string): Promise<PublicUser> {
  const [row] = await getDb()<UserRow[]>`
    SELECT id, username, name, created_at, updated_at
    FROM users
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  if (!row) throw new NotFoundError("User not found");
  return toPublicUser(row);
}

export async function updateUser(
  id: string,
  patch: { name: string },
): Promise<PublicUser> {
  const [row] = await getDb()<UserRow[]>`
    UPDATE users SET name = ${patch.name}
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id, username, name, created_at, updated_at
  `;
  if (!row) throw new NotFoundError("User not found");
  return toPublicUser(row);
}

/** Soft-deletes the user and revokes all of their sessions atomically. */
export async function softDeleteUser(id: string): Promise<void> {
  await getDb().begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      UPDATE users SET deleted_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING id
    `;
    if (!row) throw new NotFoundError("User not found");
    await tx`DELETE FROM sessions WHERE user_id = ${id}`;
  });
}
