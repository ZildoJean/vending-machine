import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { exitWithError } from './infra/db/errors';
import { resolveMigrationsFolder } from './infra/db/migrations-path';
import { loadEnvFiles } from './infra/load-env';

/** À lancer avec le rôle PROPRIÉTAIRE (MIGRATION_DATABASE_URL), jamais avec le rôle applicatif. */
async function run(): Promise<void> {
  const files = loadEnvFiles();
  if (files.length > 0) console.log(`Configuration lue dans : ${files.join(', ')}`);
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      'MIGRATION_DATABASE_URL ou DATABASE_URL requis : définissez-la dans le fichier .env (à la racine du projet) ou dans votre terminal',
    );
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolveMigrationsFolder(import.meta.url) });
    console.log('Migrations appliquées.');
  } finally {
    await pool.end();
  }
}
run().catch((e: unknown) => exitWithError(e, process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL));
