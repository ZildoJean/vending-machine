import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  PIN_PEPPER: z.string().min(32, 'PIN_PEPPER : 32 caractères minimum'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  // Limitation de débit PAR ADRESSE IP, par minute. Attention : des clients derrière une même adresse (Wi-Fi partagé,
  // NAT d'opérateur mobile) PARTAGENT ce quota : augmenter si le lieu d'usage est dans ce cas.
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(10).max(1_000_000).default(300),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().min(3).max(100_000).default(10),
  RATE_LIMIT_DEPOSIT_MAX: z.coerce.number().int().min(5).max(100_000).default(60),
});

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly pepper: string;
  readonly allowedOrigins: readonly string[];
  readonly cookieSecure: boolean;
  readonly trustProxy: boolean;
  readonly logLevel: string;
  readonly lockTimeoutMs: number;
  readonly dbPoolMax: number;
  readonly limits: { readonly windowMs: number; readonly globalMax: number; readonly loginMax: number; readonly depositMax: number };
}

/** Lève une erreur claire (sans afficher les valeurs secrètes) si la configuration est invalide. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ');
    throw new Error(`Configuration invalide — ${problems}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && /CHANGE-?ME/i.test(e.PIN_PEPPER)) {
    throw new Error("Configuration invalide — PIN_PEPPER est encore la valeur d'exemple");
  }
  const origins = e.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const o of origins) {
    try {
      if (new URL(o).origin !== o) throw new Error();
    } catch {
      throw new Error(`Configuration invalide — ALLOWED_ORIGINS contient une origine incorrecte (${o})`);
    }
  }
  const cookieSecure = e.COOKIE_SECURE ?? e.NODE_ENV === 'production';
  if (e.NODE_ENV === 'production' && !cookieSecure) {
    throw new Error('Configuration invalide — COOKIE_SECURE=false interdit en production');
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    pepper: e.PIN_PEPPER,
    allowedOrigins: origins,
    cookieSecure,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    lockTimeoutMs: e.LOCK_TIMEOUT_MS,
    dbPoolMax: e.DB_POOL_MAX,
    limits: {
      windowMs: 60_000,
      globalMax: e.RATE_LIMIT_GLOBAL_MAX,
      loginMax: e.RATE_LIMIT_LOGIN_MAX,
      depositMax: e.RATE_LIMIT_DEPOSIT_MAX,
    },
  };
}
