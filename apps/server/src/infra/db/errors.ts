/** Drizzle enveloppe les erreurs du pilote (`cause`) : on remonte la chaîne pour trouver le code SQLSTATE. */
export function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur !== null && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PG_LOCK_NOT_AVAILABLE = '55P03';

/** Le verrou n'a pas pu être obtenu à temps : à traduire en 503 (réessayer), jamais en blocage infini. */
export class LockTimeoutError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Verrou de la machine indisponible (délai dépassé)', options);
    this.name = 'LockTimeoutError';
  }
}

/** Code d'erreur le plus profond : suit `cause` (ORM) et `errors[]` (AggregateError : localhost IPv4 + IPv6). */
export function rootCode(e: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (x: unknown): string | undefined => {
    if (x === null || typeof x !== 'object' || seen.has(x)) return undefined;
    seen.add(x);
    const o = x as { code?: unknown; cause?: unknown; errors?: unknown[] };
    const inner = walk(o.cause) ?? o.errors?.map(walk).find((c) => c !== undefined);
    return inner ?? (typeof o.code === 'string' ? o.code : undefined);
  };
  return walk(e);
}

/**
 * Consigne claire pour les erreurs de connexion courantes (jamais le mot de passe). L'ORM enveloppe la vraie cause dans
 * « Failed query: … » : sans cela, « PostgreSQL arrêté » et « mot de passe faux » donnent le même message inutile.
 */
export function explainDbError(e: unknown, connectionString: string | undefined): string | null {
  let who = '?';
  let host = '?';
  let db = '?';
  try {
    if (connectionString) {
      const u = new URL(connectionString);
      who = decodeURIComponent(u.username);
      host = `${u.hostname}:${u.port || 5432}`;
      db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    }
  } catch {
    /* URL illisible : on explique quand même */
  }
  switch (rootCode(e)) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return `PostgreSQL est injoignable sur ${host}. Vérifiez qu'il est démarré et que l'adresse (DATABASE_URL / MIGRATION_DATABASE_URL) est correcte.`;
    case '28P01':
    case '28000':
      return `Connexion refusée pour le rôle « ${who} » : mot de passe ou rôle incorrect (DATABASE_URL / MIGRATION_DATABASE_URL).`;
    case '3D000':
      return `La base « ${db} » n'existe pas. Créez-la (psql -U postgres) : CREATE DATABASE ${db} OWNER ${who};`;
    case '42501':
      return `Droits insuffisants pour le rôle « ${who} ». Les migrations doivent utiliser le rôle PROPRIÉTAIRE de la base (MIGRATION_DATABASE_URL).`;
    default:
      return null;
  }
}

/** Affiche une erreur fatale de façon lisible et termine le processus en erreur. */
export function exitWithError(e: unknown, connectionString?: string): never {
  console.error(explainDbError(e, connectionString) ?? (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
