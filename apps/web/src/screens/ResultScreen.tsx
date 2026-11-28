import { formatAr } from '@vending/shared';
import { useEffect, useRef } from 'react';
import { Button, Card } from '../components/ui';
import type { FinalResult } from './result-types';

const TITLES = {
  DISPENSED: 'Commande servie',
  PARTIALLY_DISPENSED: 'Commande partiellement servie',
  FAILED: 'Distribution impossible',
  PENDING_DISPENSE: 'Commande en cours',
} as const;

export function ResultScreen({ result, onDone }: { result: FinalResult; onDone: () => void }) {
  const { outcome, lines } = result;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []); // le lecteur d'écran lit le résultat dès l'affichage

  const delivered = lines.reduce((n, l) => n + l.deliveredQty, 0);
  const ordered = lines.reduce((n, l) => n + l.qty, 0);
  const tone = outcome.status === 'DISPENSED' ? 'text-emerald-800' : outcome.status === 'FAILED' ? 'text-red-800' : 'text-amber-800';

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <h2 ref={heading} tabIndex={-1} className={`mb-2 text-2xl font-bold outline-none ${tone}`}>
          {TITLES[outcome.status]}
        </h2>
        <div aria-live="polite">
          <p className="mb-3">
            {delivered} boisson(s) servie(s) sur {ordered}.
          </p>
          {outcome.status !== 'DISPENSED' && (
            <p className="mb-3 font-medium">
              {outcome.refundedAr > 0 ? `${formatAr(outcome.refundedAr)} ont été remboursés dans votre wallet.` : 'Aucun remboursement.'}
            </p>
          )}
        </div>
        <ul className="mb-4 divide-y divide-slate-200">
          {lines.map((l) => (
            <li key={l.name} className="flex justify-between py-2">
              <span>
                {l.name} <span className="text-slate-600">({formatAr(l.priceAr)})</span>
              </span>
              <span className={l.deliveredQty < l.qty ? 'font-semibold text-red-800' : ''}>
                {l.deliveredQty} / {l.qty} {l.deliveredQty < l.qty ? 'non servie(s)' : 'servie(s)'}
              </span>
            </li>
          ))}
        </ul>
        <dl className="mb-4 grid grid-cols-2 gap-y-1 text-sm">
          <dt>Total de la commande</dt>
          <dd className="text-right">{formatAr(outcome.totalAr)}</dd>
          <dt>Remboursé</dt>
          <dd className="text-right">{formatAr(outcome.refundedAr)}</dd>
          <dt className="font-semibold">Solde du wallet</dt>
          <dd className="text-right font-semibold">{formatAr(outcome.balanceAr)}</dd>
        </dl>
        <p className="mb-4 text-sm text-slate-700">
          Votre session est terminée. Le solde restant est conservé pour votre prochaine visite.
        </p>
        <Button onClick={onDone} className="w-full">
          Terminer
        </Button>
      </Card>
    </div>
  );
}
