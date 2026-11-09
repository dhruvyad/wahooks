-- "Newest N deliveries for this webhook": GET /webhooks/:id/logs and the API's retention trim
-- (keep the last 100 per webhook). On production the index was built beforehand with
-- CREATE INDEX CONCURRENTLY (this migrator runs in one transaction, where a plain build would block
-- event inserts for the length of the build), so this is a no-op there.
CREATE INDEX IF NOT EXISTS "webhook_event_logs_config_created_idx" ON "webhook_event_logs" USING btree ("webhook_config_id","created_at" DESC);
