import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const DEFAULT_ADMIN_URL = 'postgres://vending:vending@localhost:5432/postgres';

/** Transforme une erreur de connexion en consigne claire (le défaut le plus fréquent : un rôle sans CREATEDB). */
export function explainTestDbProblem(e: unknown, adminUrl: string): string | null {
  const u = new URL(adminUrl);
  const who = decodeURIComponent(u.username);
  const raw = e as { code?: string; errors?: { code?: string }[] };
  const code = raw.code ?? raw.errors?.[0]?.code;
  if (code === '42501') {
    return [
      `Le rôle PostgreSQL « ${who} » n'a pas le droit de créer des bases de données, or chaque fichier de test en crée une temporaire.`,
      `Solution (une fois, avec un superutilisateur, ex. « psql -U postgres ») :`,
      `    ALTER ROLE "${who}" CREATEDB CREATEROLE;`,
      `(CREATEROLE sert seulement au test de séparation des droits ; sans lui, ce test est ignoré.)`,
      `Ou utiliser un autre rôle : définir TEST_PG_ADMIN_URL=postgres://<superutilisateur>:<motdepasse>@localhost:5432/postgres`,
      `    PowerShell : $env:TEST_PG_ADMIN_URL="..."     cmd : set TEST_PG_ADMIN_URL=...     bash : export TEST_PG_ADMIN_URL=...`,
    ].join('\n');
  }
  if (code === '28P01' || code === '28000') {
    return `Connexion refusée pour le rôle « ${who} » : mot de passe ou rôle incorrect. Vérifier TEST_PG_ADMIN_URL (actuel : ${u.protocol}//${who}:***@${u.host}${u.pathname}).`;
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return `PostgreSQL est injoignable sur ${u.hostname}:${u.port || 5432}. Le démarrer, ou corriger TEST_PG_ADMIN_URL (port, hôte).`;
  }
  return null;
}
// chemins (et non objets URL) : sous jsdom, la classe URL n'est pas celle de Node
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export interface TestDb {
  readonly pool: Pool;
  readonly name: string;
  readonly adminUrl: string;
  drop(): Promise<void>;
}

/** Une base PostgreSQL NEUVE par fichier de test : migrations réelles, vraies contraintes. */
export async function createTestDb(adminUrl: string = process.env.TEST_PG_ADMIN_URL ?? DEFAULT_ADMIN_URL): Promise<TestDb> {
  const ADMIN_URL = adminUrl;
  const name = `vending_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (e) {
    const hint = explainTestDbProblem(e, ADMIN_URL);
    throw hint === null ? e : new Error(hint, { cause: e });
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 6 });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

  return {
    pool,
    name,
    adminUrl: ADMIN_URL,
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
