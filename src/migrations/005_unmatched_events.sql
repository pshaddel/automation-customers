-- Unmatched events: an event that matched no listener, kept so a run that starts waiting
-- right after it (the reply beat the wait listener) can still claim it.
-- Design: docs/automation.md, "Unmatched events".
-- Only event types some wait trigger listens for are stored. Rows are claimed with
-- DELETE ... RETURNING (like listeners), so there's no status or soft delete.
CREATE TABLE automation_unmatched_events (
  event_type      text        NOT NULL,
  event_id        text        NOT NULL,
  -- One row per key from the trigger types' eventKeys(event).
  correlation_key text        NOT NULL,
  event           jsonb       NOT NULL,
  -- When the webhook arrived (the event job's enqueue time), not when the job ran.
  received_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A retried event job inserts nothing new.
  PRIMARY KEY (event_type, event_id, correlation_key)
);

-- Lookup when a run starts waiting.
CREATE INDEX automation_unmatched_events_lookup_idx
  ON automation_unmatched_events (event_type, correlation_key, received_at);

-- Cleanup of old rows.
CREATE INDEX automation_unmatched_events_received_at_idx
  ON automation_unmatched_events (received_at);
