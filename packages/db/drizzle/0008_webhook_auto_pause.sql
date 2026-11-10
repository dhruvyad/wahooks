-- A webhook whose deliveries all fail for days is paused instead of retrying forever (see
-- WebhookDeliveryProcessor). failing_since marks the start of the current run of given-up deliveries
-- and is cleared by any success; paused_reason 'failing' tells an automatic pause from an owner's
-- switch-off. Nullable columns without defaults don't rewrite the table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD COLUMN IF NOT EXISTS "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD COLUMN IF NOT EXISTS "paused_reason" text;
