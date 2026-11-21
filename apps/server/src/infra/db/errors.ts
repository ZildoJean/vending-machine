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
