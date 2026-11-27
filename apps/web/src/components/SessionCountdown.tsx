import { useEffect, useRef } from 'react';
import { useNow } from '../hooks/use-now';
import { WARNING_MS, formatMmSs, remainingAt } from '../lib/countdown';

interface Props {
  /** Mesure SERVEUR (pas d'écart d'horloge), relevée à `syncedAt`. null : pas d'expiration (distribution). */
  remainingMs: number | null;
  syncedAt: number;
  onExpire: () => void;
}

export function SessionCountdown({ remainingMs, syncedAt, onExpire }: Props) {
  const now = useNow();
  const left = remainingMs === null ? null : remainingAt(remainingMs, syncedAt, now);
  const fired = useRef(false);

  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onExpire();
    }
    if (left !== null && left > 0) fired.current = false;
  }, [left, onExpire]);

  if (left === null) return <p className="text-sm text-slate-700">Distribution en cours…</p>;
  const warn = left <= WARNING_MS;
  return (
    <div>
      <p className={`text-sm font-semibold ${warn ? 'text-red-800' : 'text-slate-700'}`}>
        Session :{' '}
        <span role="timer" aria-label={`Temps restant ${formatMmSs(left)}`}>
          {formatMmSs(left)}
        </span>
      </p>
      {/* annoncé une seule fois, à l'entrée dans la zone d'alerte */}
      {warn && left > 0 && (
        <p role="status" className="sr-only">
          Votre session expire dans moins de 30 secondes. Une action la prolonge.
        </p>
      )}
    </div>
  );
}
