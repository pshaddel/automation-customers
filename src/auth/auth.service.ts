import { SQL } from "bun";
import { getDb } from "../db/db";
import { ConflictError, UnauthorizedError } from "../lib/errors";
import {
  type CreateUserInput,
  createUser,
  findActiveUserCredentials,
  hashPassword,
  type PublicUser,
  toPublicUser,
  type UserRow,
  verifyPassword,
} from "../users/users.service";

export { hashPassword, verifyPassword };

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Session = { token: string; expiresAt: Date };

const INVALID_CREDENTIALS = "Invalid username or password";

// Hash of a random throwaway password, computed lazily once. Verifying against it when the
// username is unknown makes that path cost roughly the same as a real wrong-password check.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomUUID());
  return dummyHash;
}

/** Sessions are stored by sha256(token) so a DB leak doesn't leak usable tokens. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<Session> {
  const token = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb()`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, ${expiresAt})
  `;
  return { token, expiresAt };
}

/** Returns the session's user if the session is valid and the user is not deleted. */
export async function getSessionUser(
  token: string,
): Promise<PublicUser | null> {
  if (!token) return null;
  const [row] = await getDb()<UserRow[]>`
    SELECT u.id, u.username, u.name, u.created_at, u.updated_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${hashToken(token)}
      AND s.expires_at > now()
      AND u.deleted_at IS NULL
  `;
  return row ? toPublicUser(row) : null;
}

export async function deleteSession(token: string): Promise<void> {
  await getDb()`DELETE FROM sessions WHERE id = ${hashToken(token)}`;
}

export async function deleteUserSessions(userId: string): Promise<void> {
  await getDb()`DELETE FROM sessions WHERE user_id = ${userId}`;
}

function isUniqueViolation(error: unknown): boolean {
  // Bun exposes the SQLSTATE as `errno`; `code` is Bun's own ("ERR_POSTGRES_SERVER_ERROR").
  return (
    error instanceof SQL.PostgresError &&
    (error.errno === "23505" || error.code === "23505")
  );
}

export async function signUp(
  input: CreateUserInput,
): Promise<{ user: PublicUser; session: Session }> {
  let user: PublicUser;
  try {
    user = await createUser(input);
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("Username is already taken");
    throw error;
  }
  const session = await createSession(user.id);
  return { user, session };
}

export async function signIn(input: {
  username: string;
  password: string;
}): Promise<{ user: PublicUser; session: Session }> {
  const found = await findActiveUserCredentials(input.username);
  if (!found) {
    await verifyPassword(input.password, await getDummyHash());
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }
  const { passwordHash, ...user } = found;
  if (!(await verifyPassword(input.password, passwordHash))) {
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }
  const session = await createSession(user.id);
  return { user, session };
}
