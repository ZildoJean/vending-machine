-- Verrouille la ligne du wallet et renvoie le solde, SANS donner au rôle applicatif aucun droit d'écriture
-- sur wallets (SELECT ... FOR UPDATE exigerait le droit UPDATE).
CREATE FUNCTION lock_wallet(p_user uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT balance_ar FROM wallets WHERE user_id = p_user FOR UPDATE
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_wallet(uuid) FROM PUBLIC;
