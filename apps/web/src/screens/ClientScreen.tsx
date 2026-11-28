import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAr } from '@vending/shared';
import type { MeResponse, OrderOutcome, ProductDto } from '@vending/shared';
import { useMemo, useRef, useState } from 'react';
import { NetworkError } from '../api/client';
import { SessionCountdown } from '../components/SessionCountdown';
import { Alert, Button, Card } from '../components/ui';
import { describeError } from '../i18n/fr';
import { canInsert } from '../lib/bills';
import { cartLines, cartStatus, prune, setQty } from '../lib/cart-model';
import type { Cart } from '../lib/cart-model';
import { IdempotencyKeys } from '../lib/idempotency';
import { uuid } from '../lib/uuid';
import { useApi } from '../state/api-context';
import type { FinalResult } from './result-types';

interface Props {
  me: MeResponse;
  /** Instant (ms) où `me.remainingMs` a été mesuré par le serveur. */
  syncedAt: number;
  onFinished: (r: FinalResult) => void;
  onLoggedOut: () => void;
  /** La réponse d'une validation a été perdue : le résultat est INCERTAIN (la commande a pu être traitée). */
  onOrderUncertain: () => void;
}

export function ClientScreen({ me, syncedAt, onFinished, onLoggedOut, onOrderUncertain }: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const productsQ = useQuery({ queryKey: ['products'], queryFn: api.products });
  const walletQ = useQuery({ queryKey: ['wallet'], queryFn: api.wallet });
  const lastQ = useQuery({ queryKey: ['last-order'], queryFn: api.lastOrder });

  const products: readonly ProductDto[] = useMemo(() => productsQ.data?.products ?? [], [productsQ.data]);
  const balanceAr = walletQ.data?.balanceAr ?? 0;
  const capAr = walletQ.data?.walletCapAr ?? 0;

  const [rawCart, setRawCart] = useState<Cart>({});
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState<{ bill: number; id: string } | null>(null);
  const keys = useRef(new IdempotencyKeys());

  // Le panier AFFICHÉ et envoyé est dérivé : jamais au-delà du stock courant (qui peut baisser entre deux affichages).
  const cart = useMemo(() => prune(rawCart, products), [rawCart, products]);
  const setCart = (f: (c: Cart) => Cart) => setRawCart((c) => f(prune(c, products)));

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  const deposit = useMutation({
    mutationFn: (v: { bill: number; id: string }) => api.deposit({ bill: v.bill, insertionId: v.id }),
    onSuccess: () => {
      setLost(null);
      refreshAll();
    },
    onError: (e, v) => {
      // réponse perdue : l'effet est INCERTAIN, on garde le même identifiant pour pouvoir réessayer sans double crédit
      setLost(e instanceof NetworkError ? v : null);
      setError(describeError(e));
    },
  });

  const checkout = useMutation({
    mutationFn: () => api.order(cartLines(cart), keys.current.keyFor(cart)),
    onSuccess: (outcome: OrderOutcome) => {
      const byId = new Map(products.map((p) => [p.id, p]));
      onFinished({
        outcome,
        lines: outcome.items.map((i) => ({
          name: byId.get(i.productId)?.name ?? 'Boisson',
          priceAr: byId.get(i.productId)?.priceAr ?? 0,
          qty: i.qty,
          deliveredQty: i.deliveredQty,
        })),
      });
    },
    onError: (e) => {
      setError(describeError(e));
      if (e instanceof NetworkError)
        onOrderUncertain(); // on ne rafraîchit pas à l'aveugle : la session a pu se fermer
      else refreshAll(); // refus du serveur : stock ou solde ont peut-être changé
    },
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: onLoggedOut,
    onError: (e) => setError(describeError(e)),
  });

  const status = cartStatus(cart, products, balanceAr, capAr);
  const busy = checkout.isPending || deposit.isPending || logout.isPending;
  const byId = new Map(products.map((p) => [p.id, p]));

  const insert = (bill: number) => {
    setError(null);
    deposit.mutate({ bill, id: uuid() });
  };

  const message = (() => {
    switch (status.kind) {
      case 'EMPTY':
        return 'Choisissez au moins une boisson.';
      case 'OK':
        return `Prêt : ${formatAr(status.totalAr)} seront débités de votre wallet.`;
      case 'NEED_MONEY':
        return `Il manque ${formatAr(status.missingAr)} : insérez des billets.`;
      case 'OVER_CAP':
        return `Le total (${formatAr(status.totalAr)}) dépasse le plafond du wallet (${formatAr(capAr)}) : retirez des boissons.`;
    }
  })();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex items-center justify-between lg:col-span-3">
        <p className="text-sm">
          Connecté : <strong>{me.login}</strong>
        </p>
        <div className="flex items-center gap-4">
          <SessionCountdown
            remainingMs={me.remainingMs}
            syncedAt={syncedAt}
            onExpire={() => void qc.invalidateQueries({ queryKey: ['me'] })}
          />
          <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Me déconnecter
          </Button>
        </div>
      </div>

      {error !== null && (
        <div className="lg:col-span-3">
          <Alert>{error}</Alert>
          {lost !== null && (
            <Button
              variant="secondary"
              className="mt-2"
              onClick={() => {
                setError(null);
                deposit.mutate(lost);
              }}
            >
              Réessayer l&apos;insertion du billet de {formatAr(lost.bill)}
            </Button>
          )}
        </div>
      )}

      <Card title="Boissons" className="lg:col-span-2">
        {productsQ.isPending && <p>Chargement…</p>}
        {productsQ.isError && <Alert>{describeError(productsQ.error)}</Alert>}
        <ul className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => {
            const qty = cart[p.id] ?? 0;
            return (
              <li key={p.id} className="flex flex-col gap-2 rounded-md border border-slate-300 p-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-semibold">{p.name}</h3>
                  <span>{formatAr(p.priceAr)}</span>
                </div>
                <p className={`text-xs ${p.stock === 0 ? 'font-semibold text-red-800' : 'text-slate-600'}`}>
                  {p.stock === 0 ? 'Épuisé' : `${p.stock} en stock`}
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    aria-label={`Retirer une ${p.name}`}
                    disabled={busy || qty === 0}
                    onClick={() => setCart((c) => setQty(c, p, qty - 1))}
                  >
                    −
                  </Button>
                  <span aria-label={`Quantité de ${p.name}`} className="min-w-6 text-center text-lg font-semibold">
                    {qty}
                  </span>
                  <Button
                    variant="secondary"
                    aria-label={`Ajouter une ${p.name}`}
                    disabled={busy || qty >= p.stock}
                    onClick={() => setCart((c) => setQty(c, p, qty + 1))}
                  >
                    +
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="flex flex-col gap-4">
        <Card title="Mon wallet">
          <p className="text-3xl font-bold" aria-label="Solde du wallet">
            {formatAr(balanceAr)}
          </p>
          <p className="mb-3 text-xs text-slate-600">
            Plafond : {formatAr(capAr)}. Le monnayeur ne rend pas la monnaie : l&apos;argent non dépensé reste dans le wallet.
          </p>
          <p className="mb-1 text-sm font-medium" id="slot-label">
            Fente à billets
          </p>
          <div role="group" aria-labelledby="slot-label" className="grid grid-cols-2 gap-2">
            {(walletQ.data?.acceptedBills ?? []).map((bill) => {
              const fits = canInsert(balanceAr, bill, capAr);
              return (
                <Button
                  key={bill}
                  variant="secondary"
                  disabled={busy || !fits}
                  title={fits ? undefined : 'Le plafond du wallet serait dépassé'}
                  aria-label={`Insérer un billet de ${formatAr(bill)}`}
                  onClick={() => insert(bill)}
                >
                  {formatAr(bill)}
                </Button>
              );
            })}
          </div>
        </Card>

        <Card title="Ma commande">
          {status.kind === 'EMPTY' ? (
            <p className="text-sm text-slate-700">{message}</p>
          ) : (
            <>
              <ul className="mb-3 divide-y divide-slate-200 text-sm">
                {Object.entries(cart).map(([id, qty]) => (
                  <li key={id} className="flex justify-between py-1">
                    <span>
                      {byId.get(id)?.name} × {qty}
                    </span>
                    <span>{formatAr((byId.get(id)?.priceAr ?? 0) * qty)}</span>
                  </li>
                ))}
              </ul>
              <p className="mb-2 flex justify-between font-semibold">
                <span>Total</span>
                <span>{formatAr(status.totalAr)}</span>
              </p>
              <p className={`mb-3 text-sm ${status.kind === 'OK' ? 'text-emerald-800' : 'text-amber-900'}`}>{message}</p>
            </>
          )}
          <Button
            className="w-full"
            disabled={status.kind !== 'OK' || busy}
            aria-busy={checkout.isPending}
            onClick={() => {
              setError(null);
              checkout.mutate();
            }}
          >
            {checkout.isPending ? 'Distribution en cours…' : 'Valider la commande'}
          </Button>
          {checkout.isPending && (
            <p role="status" className="mt-2 text-sm">
              Votre commande est en cours de distribution, ne quittez pas la page.
            </p>
          )}
        </Card>

        <details className="rounded-lg bg-white p-4 shadow">
          <summary className="cursor-pointer text-sm font-semibold">Ma dernière commande</summary>
          {lastQ.data ? (
            <p className="mt-2 text-sm">
              {lastQ.data.status === 'DISPENSED'
                ? 'Servie'
                : lastQ.data.status === 'PARTIALLY_DISPENSED'
                  ? 'Partiellement servie'
                  : lastQ.data.status === 'FAILED'
                    ? 'Non servie'
                    : 'En cours'}
              {' — '}
              {formatAr(lastQ.data.totalAr)}, remboursé {formatAr(lastQ.data.refundedAr)}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Aucune commande.</p>
          )}
        </details>
      </div>
    </div>
  );
}
