import { Pool } from 'pg';
import { createDb } from './infra/db/client';
import { PgUnitOfWork } from './infra/db/pg-unit-of-work';
import { AdminService } from './application/admin-service';
import { MONEY_CONFIG, TIMEOUT_CONFIG } from '@vending/shared';
import { systemClock } from './infra/clock/system-clock';
import { loadConfig } from './infra/config';
import { exitWithError } from './infra/db/errors';
import { loadEnvFiles } from './infra/load-env';
import { Argon2SecretHasher } from './infra/security/argon2-hasher';

/** Crée le premier administrateur : ADMIN_LOGIN et ADMIN_PASSWORD (12 caractères minimum) en variables d'environnement. */
async function run(): Promise<void> {
  loadEnvFiles();
  const cfg = loadConfig(process.env);
  const login = process.env.ADMIN_LOGIN;
  const password = process.env.ADMIN_PASSWORD;
  if (!login || !password) throw new Error('ADMIN_LOGIN et ADMIN_PASSWORD requis (fichier .env ou terminal)');
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 2 });
  try {
    const admin = new AdminService({
      uow: new PgUnitOfWork(createDb(pool)),
      clock: systemClock,
      hasher: new Argon2SecretHasher({ pepper: cfg.pepper }),
      money: MONEY_CONFIG,
      timeouts: TIMEOUT_CONFIG,
    });
    const r = await admin.createAdmin(login, password);
    if (!r.ok)
      throw new Error(
        `Création refusée : ${r.error.kind}${'reason' in r.error ? ` (${String(r.error.reason)})` : ''}${'code' in r.error ? ` (${String(r.error.code)})` : ''}`,
      );
    console.log(`Administrateur créé : ${login}`);
  } finally {
    await pool.end();
  }
}
run().catch((e: unknown) => exitWithError(e, process.env.DATABASE_URL));
