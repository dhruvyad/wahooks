-- Supabase advisor 2026-09-13 (rls_disabled_in_public, sensitive_columns_exposed):
-- Drizzle creates tables as `postgres`, and Supabase's default privileges hand
-- every such table to the `anon`/`authenticated` PostgREST roles with RLS OFF —
-- so the public browser key could read every signing_secret, email, phone
-- number and token hash, and DELETE/TRUNCATE any table. Nothing reaches these
-- tables through PostgREST (the web app uses supabase-js for auth only; the API
-- and this migrator run as `postgres`, which owns the tables and bypasses RLS),
-- so lock the API roles out entirely and stop future tables inheriting the grant.
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waha_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waha_workers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_event_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
