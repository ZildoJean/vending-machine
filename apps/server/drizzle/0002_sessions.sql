CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"machine_started_at" bigint,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "sessions_hash_len_ck" CHECK (char_length("sessions"."token_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_user_uq" ON "sessions" USING btree ("user_id");