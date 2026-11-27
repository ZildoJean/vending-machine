export const CLIENT_PIN_LENGTH = 6;
export const ADMIN_PASSWORD_MIN = 12;
export const SECRET_MAX = 128;

export const AUTH_POLICY = {
  /** Tentatives autorisées avant verrouillage du compte. */
  maxAttempts: 5,
  /** Durée du verrouillage (ms). */
  lockMs: 5 * 60_000,
  /** Inactivité maximale d'une session administrateur (ms) et durée absolue. */
  adminIdleMs: 30 * 60_000,
  adminAbsoluteMs: 8 * 3_600_000,
} as const;

/** PIN trivial (tous identiques, suite montante ou descendante) : refusé à la création. */
export function isWeakPin(pin: string): boolean {
  if (!/^\d+$/.test(pin)) return true;
  if (new Set(pin).size === 1) return true;
  const d = [...pin].map(Number);
  const step = (d[1] ?? 0) - (d[0] ?? 0);
  return (step === 1 || step === -1) && d.every((x, i) => i === 0 || x - (d[i - 1] ?? 0) === step);
}

export function validateClientPin(pin: string): 'OK' | 'BAD_FORMAT' | 'WEAK' {
  if (!new RegExp(`^\\d{${CLIENT_PIN_LENGTH}}$`).test(pin)) return 'BAD_FORMAT';
  return isWeakPin(pin) ? 'WEAK' : 'OK';
}

export function validateAdminPassword(pw: string): 'OK' | 'TOO_SHORT' | 'WEAK' {
  if (pw.length < ADMIN_PASSWORD_MIN) return 'TOO_SHORT';
  return new Set(pw).size < 4 ? 'WEAK' : 'OK';
}

export const STOCK_LIMITS = { maxRestockQty: 1_000, maxStock: 10_000 } as const;
