/** Temps restant à l'instant `now`, à partir d'une mesure serveur (`remainingMs` relevé à `syncedAt`). */
/**
 * `now` peut être légèrement ANTÉRIEUR à `syncedAt` (mesure serveur arrivée entre deux ticks) : le temps écoulé
 * est borné à 0, sinon on afficherait plus de temps que le serveur n'en accorde.
 */
export const remainingAt = (remainingMs: number, syncedAt: number, now: number): number =>
  Math.max(0, remainingMs - Math.max(0, now - syncedAt));

export function formatMmSs(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export const WARNING_MS = 30_000;
