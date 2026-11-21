import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://vending:vending@localhost:5432/postgres';
const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb {
  readonly pool: Pool;
  drop(): Promise<void>;
}

/** Une base PostgreSQL NEUVE par fichier de test : migrations réelles, vraies contraintes. */
export async function createTestDb(): Promise<TestDb> {
  const name = `vending_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 6 });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

  return {
    pool,
    async drop() {
      await pool.end();
      const a = new Pool({ connectionString: ADMIN_URL, max: 1 });
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
