-- Amorçage du singleton machine_state
INSERT INTO "machine_state" ("id", "kind") VALUES (1, 'IDLE');
--> statement-breakpoint

-- Registres append-only : aucune modification ni suppression, même par un bug applicatif
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la table % est append-only (% interdit)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_append_only BEFORE UPDATE OR DELETE ON "wallet_ledger"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_no_truncate BEFORE TRUNCATE ON "wallet_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON "stock_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Le singleton machine_state ne peut être ni supprimé ni vidé (seulement mis à jour)
CREATE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la table % ne peut pas être vidée (% interdit)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER machine_state_no_delete BEFORE DELETE ON "machine_state"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER machine_state_no_truncate BEFORE TRUNCATE ON "machine_state"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint

-- Un client a toujours un wallet
CREATE FUNCTION create_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'CLIENT' THEN
    INSERT INTO wallets (user_id) VALUES (NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_create_wallet AFTER INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION create_wallet();
--> statement-breakpoint

-- Le solde = somme du registre, maintenu atomiquement. Le CHECK de wallets (0..plafond, multiple
-- du pas) annule TOUTE l'insertion fautive. L'UPDATE verrouille la ligne du wallet : deux
-- écritures concurrentes sur un même wallet sont sérialisées.
CREATE FUNCTION apply_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallets SET balance_ar = balance_ar + NEW.amount_ar WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aucun wallet pour l''utilisateur %', NEW.user_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wallet_ledger_apply AFTER INSERT ON "wallet_ledger"
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();
--> statement-breakpoint

-- Idem pour le stock : jamais négatif, maintenu à partir des mouvements
CREATE FUNCTION apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE products SET stock = stock + NEW.delta WHERE id = NEW.product_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_apply AFTER INSERT ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();
