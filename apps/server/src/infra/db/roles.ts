import type { Pool } from 'pg';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export interface AppRoleOptions {
  readonly role: string;
  readonly password: string;
  readonly database: string;
}

/**
 * Crée (ou met à jour) le rôle APPLICATIF restreint et règle ses droits. Idempotent : à relancer après
 * CHAQUE migration (les nouvelles tables n'héritent pas des droits). À exécuter avec le rôle PROPRIÉTAIRE.
 *
 * PIÈGE PostgreSQL : un REVOKE sur une COLONNE est sans effet si le droit existe sur la TABLE entière :
 * on retire le droit de table, puis on accorde seulement les colonnes autorisées.
 * Le solde et le stock n'existent QUE par les déclencheurs (SECURITY DEFINER) : aucune écriture directe.
 */
export async function setupAppRole(pool: Pool, o: AppRoleOptions): Promise<void> {
  if (!IDENT.test(o.role) || !IDENT.test(o.database)) throw new Error('Nom de rôle ou de base invalide (minuscules, chiffres, _)');
  if (o.password.length < 8) throw new Error('Mot de passe du rôle applicatif : 8 caractères minimum');
  const client = await pool.connect();
  try {
    const r = `"${o.role}"`;
    const pw = client.escapeLiteral(o.password);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [o.role]);
    await client.query(`${exists.rowCount === 0 ? 'CREATE' : 'ALTER'} ROLE ${r} LOGIN PASSWORD ${pw}`); // un rôle créé ainsi n'a AUCUN privilège (vérifié par test) ; ne pas citer NOSUPERUSER : réservé aux superutilisateurs
    const stmts = [
      `GRANT CONNECT ON DATABASE "${o.database}" TO ${r}`,
      `GRANT USAGE ON SCHEMA public TO ${r}`,
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${r}`,
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
      // registres : ajout seulement
      `REVOKE UPDATE ON wallet_ledger, stock_movements, audit_log FROM ${r}`,
      // solde et stock : jamais d'écriture directe (ni INSERT ni UPDATE)
      `REVOKE INSERT, UPDATE ON wallets FROM ${r}`,
      `REVOKE INSERT, UPDATE ON products FROM ${r}`,
      `GRANT INSERT (name, price_ar, active) ON products TO ${r}`,
      `GRANT UPDATE (name, price_ar, active) ON products TO ${r}`,
      // suppression : seulement les sessions
      `REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM ${r}`,
      `GRANT DELETE ON sessions TO ${r}`,
      // le schéma ne doit pas être modifiable
      `REVOKE CREATE ON SCHEMA public FROM ${r}`,
      // verrou de wallet sans droit d'écriture (voir migration lock_wallet)
      `GRANT EXECUTE ON FUNCTION lock_wallet(uuid) TO ${r}`,
    ];
    for (const s of stmts) await client.query(s);
  } finally {
    client.release();
  }
}
