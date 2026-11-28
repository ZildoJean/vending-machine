CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"admin_id" uuid,
	"started_at" bigint,
	"last_activity_at" bigint,
	"phase" text,
	CONSTRAINT "machine_state_singleton_ck" CHECK ("machine_state"."id" = 1),
	CONSTRAINT "machine_state_shape_ck" CHECK (("machine_state"."kind" = 'IDLE' AND "machine_state"."user_id" IS NULL AND "machine_state"."admin_id" IS NULL AND "machine_state"."started_at" IS NULL AND "machine_state"."last_activity_at" IS NULL AND "machine_state"."phase" IS NULL)
        OR ("machine_state"."kind" = 'CLIENT_ACTIVE' AND "machine_state"."user_id" IS NOT NULL AND "machine_state"."admin_id" IS NULL AND "machine_state"."started_at" IS NOT NULL AND "machine_state"."last_activity_at" IS NOT NULL AND "machine_state"."started_at" <= "machine_state"."last_activity_at" AND COALESCE("machine_state"."phase" IN ('SELECTING', 'DISPENSING'), false))
        OR ("machine_state"."kind" = 'MAINTENANCE' AND "machine_state"."admin_id" IS NOT NULL AND "machine_state"."user_id" IS NULL AND "machine_state"."started_at" IS NOT NULL AND "machine_state"."last_activity_at" IS NOT NULL AND "machine_state"."started_at" <= "machine_state"."last_activity_at" AND "machine_state"."phase" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_ar" integer NOT NULL,
	"delivered_qty" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_items_order_id_product_id_pk" PRIMARY KEY("order_id","product_id"),
	CONSTRAINT "order_items_qty_ck" CHECK ("order_items"."qty" > 0),
	CONSTRAINT "order_items_price_ck" CHECK ("order_items"."unit_price_ar" > 0 AND "order_items"."unit_price_ar" <= 100000 AND "order_items"."unit_price_ar" % 100 = 0),
	CONSTRAINT "order_items_delivered_ck" CHECK ("order_items"."delivered_qty" >= 0 AND "order_items"."delivered_qty" <= "order_items"."qty")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"total_ar" integer NOT NULL,
	"refunded_ar" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "orders_status_ck" CHECK ("orders"."status" IN ('PENDING_DISPENSE', 'DISPENSED', 'PARTIALLY_DISPENSED', 'FAILED')),
	CONSTRAINT "orders_total_ck" CHECK ("orders"."total_ar" > 0 AND "orders"."total_ar" <= 100000 AND "orders"."total_ar" % 100 = 0),
	CONSTRAINT "orders_refund_step_ck" CHECK ("orders"."refunded_ar" >= 0 AND "orders"."refunded_ar" % 100 = 0),
	CONSTRAINT "orders_refund_coherence_ck" CHECK (("orders"."status" = 'PENDING_DISPENSE' AND "orders"."refunded_ar" = 0)
        OR ("orders"."status" = 'DISPENSED' AND "orders"."refunded_ar" = 0)
        OR ("orders"."status" = 'PARTIALLY_DISPENSED' AND "orders"."refunded_ar" > 0 AND "orders"."refunded_ar" < "orders"."total_ar")
        OR ("orders"."status" = 'FAILED' AND "orders"."refunded_ar" = "orders"."total_ar")),
	CONSTRAINT "orders_finished_ck" CHECK (("orders"."status" = 'PENDING_DISPENSE') = ("orders"."finished_at" IS NULL)),
	CONSTRAINT "orders_idem_len_ck" CHECK (char_length("orders"."idempotency_key") BETWEEN 8 AND 100)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"price_ar" integer NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "products_name_len_ck" CHECK (char_length("products"."name") BETWEEN 1 AND 50),
	CONSTRAINT "products_price_ck" CHECK ("products"."price_ar" > 0 AND "products"."price_ar" <= 100000 AND "products"."price_ar" % 100 = 0),
	CONSTRAINT "products_stock_ck" CHECK ("products"."stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"order_id" uuid,
	"actor_id" uuid,
	"created_at" bigint NOT NULL,
	CONSTRAINT "stock_movements_reason_ck" CHECK ("stock_movements"."reason" IN ('RESTOCK', 'ADMIN_ADJUST', 'SALE', 'SALE_REVERSAL')),
	CONSTRAINT "stock_movements_shape_ck" CHECK (("stock_movements"."reason" = 'SALE' AND "stock_movements"."delta" < 0 AND "stock_movements"."order_id" IS NOT NULL AND "stock_movements"."actor_id" IS NULL)
        OR ("stock_movements"."reason" = 'SALE_REVERSAL' AND "stock_movements"."delta" > 0 AND "stock_movements"."order_id" IS NOT NULL AND "stock_movements"."actor_id" IS NULL)
        OR ("stock_movements"."reason" = 'RESTOCK' AND "stock_movements"."delta" > 0 AND "stock_movements"."order_id" IS NULL AND "stock_movements"."actor_id" IS NOT NULL)
        OR ("stock_movements"."reason" = 'ADMIN_ADJUST' AND "stock_movements"."delta" <> 0 AND "stock_movements"."order_id" IS NULL AND "stock_movements"."actor_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login" text NOT NULL,
	"role" text NOT NULL,
	"pin_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "users_role_ck" CHECK ("users"."role" IN ('CLIENT', 'ADMIN')),
	CONSTRAINT "users_failed_attempts_ck" CHECK ("users"."failed_attempts" >= 0),
	CONSTRAINT "users_login_len_ck" CHECK (char_length("users"."login") BETWEEN 3 AND 32)
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wallet_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_ar" integer NOT NULL,
	"order_id" uuid,
	"insertion_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "wallet_ledger_type_ck" CHECK ("wallet_ledger"."type" IN ('DEPOSIT', 'PURCHASE', 'REFUND')),
	CONSTRAINT "wallet_ledger_sign_ck" CHECK (("wallet_ledger"."type" = 'PURCHASE' AND "wallet_ledger"."amount_ar" < 0) OR ("wallet_ledger"."type" IN ('DEPOSIT', 'REFUND') AND "wallet_ledger"."amount_ar" > 0)),
	CONSTRAINT "wallet_ledger_step_ck" CHECK ("wallet_ledger"."amount_ar" % 100 = 0),
	CONSTRAINT "wallet_ledger_refs_ck" CHECK (("wallet_ledger"."type" = 'DEPOSIT' AND "wallet_ledger"."insertion_id" IS NOT NULL AND "wallet_ledger"."order_id" IS NULL)
        OR ("wallet_ledger"."type" IN ('PURCHASE', 'REFUND') AND "wallet_ledger"."order_id" IS NOT NULL AND "wallet_ledger"."insertion_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_ar" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wallets_balance_ck" CHECK ("wallets"."balance_ar" >= 0 AND "wallets"."balance_ar" <= 100000 AND "wallets"."balance_ar" % 100 = 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_state" ADD CONSTRAINT "machine_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_state" ADD CONSTRAINT "machine_state_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_idem_uq" ON "orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_pending_uq" ON "orders" USING btree ("status") WHERE "orders"."status" = 'PENDING_DISPENSE';--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_name_lower_uq" ON "products" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_order_product_reason_uq" ON "stock_movements" USING btree ("order_id","product_id","reason") WHERE "stock_movements"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_lower_uq" ON "users" USING btree (lower("login"));--> statement-breakpoint
CREATE INDEX "wallet_ledger_user_idx" ON "wallet_ledger" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_insertion_uq" ON "wallet_ledger" USING btree ("insertion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ledger_order_type_uq" ON "wallet_ledger" USING btree ("order_id","type") WHERE "wallet_ledger"."order_id" IS NOT NULL;