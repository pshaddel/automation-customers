-- 001_init: shared extensions and helpers used by later migrations.

CREATE EXTENSION IF NOT EXISTS citext;

-- Reusable trigger function: keeps an `updated_at` column current.
-- Usage:
--   CREATE TRIGGER <table>_set_updated_at
--     BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
