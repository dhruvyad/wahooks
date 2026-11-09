-- Which software a worker row runs: 'waha' (a pod of the WAHA StatefulSet) or 'gateway' (a wagw box).
-- Placement, per-kind scaling, the health poll's orphan sweep and event auth branch on it. A column
-- with a constant default doesn't rewrite the table; the lock timeout fails the deploy instead of
-- queueing the API's reads of waha_workers behind a long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "waha_workers" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'waha' NOT NULL;--> statement-breakpoint
ALTER TABLE "waha_workers" DROP CONSTRAINT IF EXISTS "waha_workers_kind_check";--> statement-breakpoint
ALTER TABLE "waha_workers" ADD CONSTRAINT "waha_workers_kind_check" CHECK ("kind" IN ('waha', 'gateway'));--> statement-breakpoint
-- Gateway boxes registered by hand before this column existed.
UPDATE "waha_workers" SET "kind" = 'gateway' WHERE "pod_name" LIKE 'wagw-%';
