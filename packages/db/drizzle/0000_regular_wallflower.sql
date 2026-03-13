CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "waha_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_name" text,
	"internal_ip" text,
	"api_key_enc" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"max_sessions" integer DEFAULT 50 NOT NULL,
	"current_sessions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waha_workers_pod_name_unique" UNIQUE("pod_name")
);
--> statement-breakpoint
CREATE TABLE "waha_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"worker_id" uuid,
	"session_name" text NOT NULL,
	"phone_number" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"engine" text DEFAULT 'NOWEB' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waha_sessions_session_name_unique" UNIQUE("session_name")
);
--> statement-breakpoint
CREATE TABLE "webhook_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"signing_secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_event_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_config_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"connection_hours" numeric(10, 6) NOT NULL,
	"reported_to_stripe" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waha_sessions" ADD CONSTRAINT "waha_sessions_worker_id_waha_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."waha_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD CONSTRAINT "webhook_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD CONSTRAINT "webhook_configs_session_id_waha_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_event_logs" ADD CONSTRAINT "webhook_event_logs_webhook_config_id_webhook_configs_id_fk" FOREIGN KEY ("webhook_config_id") REFERENCES "public"."webhook_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_session_id_waha_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."waha_sessions"("id") ON DELETE cascade ON UPDATE no action;