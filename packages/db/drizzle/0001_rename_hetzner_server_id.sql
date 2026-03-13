-- Rename hetzner_server_id → pod_name in waha_workers.
-- Wrapped in a conditional block so it is safe to run against both:
--   - existing production databases (where hetzner_server_id exists → renames it)
--   - fresh installs (where 0000 already created pod_name → no-op)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'waha_workers'
      AND column_name  = 'hetzner_server_id'
  ) THEN
    ALTER TABLE waha_workers RENAME COLUMN hetzner_server_id TO pod_name;
  END IF;
END $$;
