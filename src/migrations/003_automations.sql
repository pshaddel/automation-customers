-- Automations: versioned step graphs, runs, step runs and event listeners.
-- Design and reasoning: docs/automation.md.
-- Depends on 001_init.sql (set_updated_at()) and 002_users_sessions.sql (users).

CREATE TABLE automations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name               text        NOT NULL,
  active             boolean     NOT NULL DEFAULT false,
  current_version_id uuid        NULL, -- FK added below (circular with automation_versions)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz NULL
);

CREATE TRIGGER automations_set_updated_at
  BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX automations_user_id_idx ON automations (user_id, created_at) WHERE deleted_at IS NULL;

-- Immutable once published_at is set; edits go into a new draft version.
CREATE TABLE automation_versions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid        NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  version       int         NOT NULL,
  entry_step_id uuid        NULL, -- FK added below (circular with automation_steps)
  published_at  timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, version)
);

CREATE TRIGGER automation_versions_set_updated_at
  BEFORE UPDATE ON automation_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- At most one draft per automation.
CREATE UNIQUE INDEX automation_versions_one_draft_idx
  ON automation_versions (automation_id) WHERE published_at IS NULL;

ALTER TABLE automations
  ADD CONSTRAINT automations_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES automation_versions (id) ON DELETE SET NULL;

CREATE TABLE automation_steps (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid        NOT NULL REFERENCES automation_versions (id) ON DELETE CASCADE,
  -- Stable across versions; `next` and templates ({{steps.<key>.*}}) refer to steps by key.
  key        text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  -- Selects the implementation in src/automations/steps/<step_type>/. Values are permanent.
  step_type  text        NOT NULL,
  label      text        NOT NULL,
  config     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- { "<outcome>": "<step key>" }; an outcome without an entry ends the run.
  next       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, key)
);

CREATE TRIGGER automation_steps_set_updated_at
  BEFORE UPDATE ON automation_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE automation_versions
  ADD CONSTRAINT automation_versions_entry_step_id_fkey
  FOREIGN KEY (entry_step_id) REFERENCES automation_steps (id) ON DELETE SET NULL;

-- Append-only log of executions; no soft delete.
CREATE TABLE automation_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id    uuid        NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  version_id       uuid        NOT NULL REFERENCES automation_versions (id) ON DELETE CASCADE,
  trigger_event_id text        NOT NULL,
  subject_key      text        NOT NULL,
  status           text        NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_step_id  uuid        NULL REFERENCES automation_steps (id) ON DELETE SET NULL,
  -- { "trigger": <entry trigger output>, "steps": { "<step key>": <output> } }
  context          jsonb       NOT NULL DEFAULT '{"trigger": {}, "steps": {}}'::jsonb,
  step_count       int         NOT NULL DEFAULT 0,
  error            text        NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A duplicate event can't start a second run.
  UNIQUE (automation_id, trigger_event_id)
);

CREATE TRIGGER automation_runs_set_updated_at
  BEFORE UPDATE ON automation_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One active run per subject (e.g. contact) per automation.
CREATE UNIQUE INDEX automation_runs_one_active_per_subject_idx
  ON automation_runs (automation_id, subject_key)
  WHERE status IN ('running', 'waiting');

CREATE INDEX automation_runs_automation_started_idx
  ON automation_runs (automation_id, started_at DESC);

CREATE TABLE automation_step_runs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid        NOT NULL REFERENCES automation_runs (id) ON DELETE CASCADE,
  step_id     uuid        NOT NULL REFERENCES automation_steps (id) ON DELETE CASCADE,
  -- Position in the run; loops can execute the same step more than once.
  sequence    int         NOT NULL,
  status      text        NOT NULL
              CHECK (status IN ('running', 'succeeded', 'waiting', 'failed')),
  attempt     int         NOT NULL DEFAULT 1,
  input       jsonb       NULL,
  output      jsonb       NULL,
  outcome     text        NULL,
  error       text        NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE TRIGGER automation_step_runs_set_updated_at
  BEFORE UPDATE ON automation_step_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Listeners. run_id NULL = entry listener (starts runs); set = wait listener (resumes that run).
CREATE TABLE automation_triggers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   uuid        NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  version_id      uuid        NOT NULL REFERENCES automation_versions (id) ON DELETE CASCADE,
  step_id         uuid        NOT NULL REFERENCES automation_steps (id) ON DELETE CASCADE,
  run_id          uuid        NULL REFERENCES automation_runs (id) ON DELETE CASCADE,
  event_type      text        NOT NULL,
  -- Opaque key built by the trigger step, e.g. "dm:<accountId>:<contactId>".
  correlation_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER automation_triggers_set_updated_at
  BEFORE UPDATE ON automation_triggers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Lookup for incoming events.
CREATE INDEX automation_triggers_lookup_idx ON automation_triggers (event_type, correlation_key);

-- A run waits on at most one trigger at a time.
CREATE UNIQUE INDEX automation_triggers_one_per_run_idx
  ON automation_triggers (run_id) WHERE run_id IS NOT NULL;

-- One entry listener per automation.
CREATE UNIQUE INDEX automation_triggers_one_entry_per_automation_idx
  ON automation_triggers (automation_id) WHERE run_id IS NULL;
