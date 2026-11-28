import { Pool } from 'pg';
import { MONEY_CONFIG, TIMEOUT_CONFIG } from '@vending/shared';
import { assertValidMoneyConfig } from './domain/money';
import { assertValidTimeoutConfig } from './domain/machine-state';
import { loadConfig } from './infra/config';
import { exitWithError } from './infra/db/errors';
import { loadEnvFiles } from './infra/load-env';
import { createDb } from './infra/db/client';
import { PgUnitOfWork } from './infra/db/pg-unit-of-work';
import { createServices } from './infra/container';
import { SimulatedBillAcceptor } from './infra/hardware/simulated-bill-acceptor';
import { SimulatedDispenser } from './infra/hardware/simulated-dispenser';
import { buildApp, createLogger } from './infra/http/app';
import { systemClock } from './infra/clock/system-clock';
import { Argon2SecretHasher } from './infra/security/argon2-hasher';

async function main(): Promise<void> {
  loadEnvFiles();
  const cfg = loadConfig(process.env);
  assertValidMoneyConfig(MONEY_CONFIG);
  assertValidTimeoutConfig(TIMEOUT_CONFIG);

  const logger = createLogger(cfg.logLevel);
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.dbPoolMax });
  const services = createServices({
    uow: new PgUnitOfWork(createDb(pool), { lockTimeoutMs: cfg.lockTimeoutMs }),
    clock: systemClock,
    dispenser: new SimulatedDispenser({ delayMs: 400 }),
    acceptor: new SimulatedBillAcceptor(MONEY_CONFIG.acceptedBills),
    hasher: new Argon2SecretHasher({ pepper: cfg.pepper }),
    logger: { warn: (m, meta) => logger.warn(meta ?? {}, m), error: (m, meta) => logger.error(meta ?? {}, m) },
    ping: async () => void (await pool.query('SELECT 1')),
  });

  // 1. reprise AVANT d'accepter la moindre requête : clôture la commande restée en cours
  const report = await services.checkout.recoverPending();
  if (report.recovered !== null || report.machineReset) logger.warn({ report }, 'reprise au démarrage effectuée');

  // purge des sessions mortes : au démarrage puis toutes les heures (n'empêche pas l'arrêt du processus)
  const purge = async (): Promise<void> => {
    try {
      const n = await services.auth.purgeStaleSessions();
      if (n > 0) logger.info({ purged: n }, 'sessions mortes supprimées');
    } catch (e) {
      logger.error({ err: e }, 'purge des sessions échouée');
    }
  };
  await purge();
  setInterval(() => void purge(), 3_600_000).unref();

  const app = await buildApp(services, {
    logLevel: cfg.logLevel,
    cookieSecure: cfg.cookieSecure,
    allowedOrigins: cfg.allowedOrigins,
    trustProxy: cfg.trustProxy,
    limits: cfg.limits,
  });

  // 2. arrêt propre : on cesse d'accepter, on laisse finir les requêtes en cours, puis on ferme la base.
  //    Une distribution interrompue de force sera reprise au prochain démarrage.
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.warn({ signal }, 'arrêt demandé');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await app.listen({ port: cfg.port, host: cfg.host });
}

// configuration invalide (sans valeur secrète) ou base injoignable : message lisible, sortie en erreur
main().catch((e: unknown) => exitWithError(e, process.env.DATABASE_URL));
