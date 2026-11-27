-- Les déclencheurs qui maintiennent le solde et le stock s'exécutent avec les droits du PROPRIÉTAIRE.
-- Le rôle applicatif peut alors perdre le droit d'écrire directement wallets.balance_ar et
-- products.stock (voir deploy/roles.sql) : seul le registre fait foi.
ALTER FUNCTION apply_ledger_entry() SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION apply_stock_movement() SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION create_wallet() SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION forbid_mutation() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION forbid_delete() SET search_path = public, pg_temp;
