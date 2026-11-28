import { Pool } from 'pg';
import { exitWithError } from './infra/db/errors';
import { loadEnvFiles } from './infra/load-env';
import { setupAppRole } from './infra/db/roles';

/** Crée/met à jour le rôle applicatif restreint. Variables : MIGRATION_DATABASE_URL (propriétaire), APP_DB_PASSWORD, APP_DB_ROLE (défaut vending_app). */
async function run(): Promise<void> {
  loadEnvFiles();
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!url || !password) throw new Error('MIGRATION_DATABASE_URL (ou DATABASE_URL) et APP_DB_PASSWORD requis (fichier .env ou terminal)');
  const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await setupAppRole(pool, { role: process.env.APP_DB_ROLE ?? 'vending_app', password, database });
    console.log(`Rôle applicatif « ${process.env.APP_DB_ROLE ?? 'vending_app'} » configuré sur la base « ${database} ».`);
  } finally {
    await pool.end();
  }
}
run().catch((e: unknown) => exitWithError(e, process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL));
