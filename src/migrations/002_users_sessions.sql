-- Users and sessions.
-- Depends on 001_init.sql (citext extension, set_updated_at() trigger function).

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique across ALL rows, including soft-deleted users: a deleted user's
  -- username is not reusable. Simplest option; switch to a partial unique
  -- index (WHERE deleted_at IS NULL) if usernames should be freed on delete.
  username      citext      NOT NULL UNIQUE,
  name          text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Supports listing active users ordered by creation time.
CREATE INDEX users_active_created_at_idx ON users (created_at) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  id         text        PRIMARY KEY, -- sha256 hex of the session token (raw token is never stored)
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
