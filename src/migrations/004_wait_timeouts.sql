-- Wait timeouts: a wait listener can expire. NULL = waits indefinitely (entry listeners
-- and waits without timeoutSeconds). Design: docs/automation.md, "Wait timeouts".
-- The column is the source of truth: findListeners ignores expired listeners, so a late
-- timeout job can't let a reply in after the deadline.
ALTER TABLE automation_triggers ADD COLUMN expires_at timestamptz NULL;
