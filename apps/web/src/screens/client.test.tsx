import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../api/client';
import { SessionCountdown } from '../components/SessionCountdown';
import { COLA, EAU, CLIENT_ME, createFakeApi } from '../test/fake-api';
import { renderWithApi } from '../test/render';
import { ClientScreen } from './ClientScreen';
import { ResultScreen } from './ResultScreen';

const setup = (initial = {}) => {
  const fake = createFakeApi(initial);
  const onFinished = vi.fn();
  const onLoggedOut = vi.fn();
  const onOrderUncertain = vi.fn();
  const utils = renderWithApi(
    <ClientScreen
      me={CLIENT_ME}
      syncedAt={Date.now()}
      onFinished={onFinished}
      onLoggedOut={onLoggedOut}
      onOrderUncertain={onOrderUncertain}
    />,
    fake.api,
  );
  return { ...fake, onFinished, onLoggedOut, onOrderUncertain, user: userEvent.setup(), ...utils };
};
const add = async (user: ReturnType<typeof userEvent.setup>, name: string, n = 1) => {
  for (let i = 0; i < n; i++) await user.click(await screen.findByRole('button', { name: new RegExp(`Ajouter une ${name}`) }));
};
/** formatAr utilise des espaces insécables : on les accepte tous dans les noms accessibles. */
const nb = (text: string): RegExp => new RegExp(text.replace(/ /g, '\\s'));
const bill = (amount: string) => screen.findByRole('button', { name: nb(`Insérer un billet de ${amount}`) });

describe('ClientScreen : sélection', () => {
  it('affiche les boissons, prix et stock ; un produit épuisé ne peut pas être ajouté', async () => {
    setup({ products: [COLA, { id: 'p-vide', name: 'Jus', priceAr: 700, stock: 0 }] });
    expect(await screen.findByRole('heading', { name: 'Cola' })).toBeInTheDocument();
    expect(screen.getByText('5 en stock')).toBeInTheDocument();
    expect(screen.getByText('Épuisé')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ajouter une Jus/ })).toBeDisabled();
  });

  it('la quantité est plafonnée au stock : le bouton + se désactive', async () => {
    const { user } = setup();
    await add(user, 'Eau', 2);
    expect(screen.getByLabelText('Quantité de Eau')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /Ajouter une Eau/ })).toBeDisabled();
  });

  it('le total et le montant manquant sont affichés ; valider reste désactivé', async () => {
    const { user } = setup({ balance: 1_000 });
    await add(user, 'Cola', 2);
    expect(await screen.findByText(/Il manque 2 000 Ar : insérez des billets/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Valider la commande' })).toBeDisabled();
  });

  it('un panier plus cher que le plafond : message dédié (insérer des billets ne servirait à rien)', async () => {
    const { user } = setup({ products: [{ id: 'p-luxe', name: 'Luxe', priceAr: 60_000, stock: 5 }], cap: 100_000, balance: 0 });
    await add(user, 'Luxe', 2);
    expect(await screen.findByText(/dépasse le plafond du wallet/)).toBeInTheDocument();
    expect(screen.queryByText(/insérez des billets/)).not.toBeInTheDocument();
  });

  it("retirer jusqu'à 0 vide la ligne du panier", async () => {
    const { user } = setup();
    await add(user, 'Cola');
    await user.click(screen.getByRole('button', { name: /Retirer une Cola/ }));
    expect(await screen.findByText('Choisissez au moins une boisson.')).toBeInTheDocument();
  });
});

describe('ClientScreen : fente à billets', () => {
  it('un billet qui ferait dépasser le plafond est désactivé (avec explication)', async () => {
    setup({ balance: 90_000 });
    expect(await bill('20 000 Ar')).toBeDisabled();
    expect(await bill('10 000 Ar')).toBeEnabled();
    expect(await bill('20 000 Ar')).toHaveAttribute('title', expect.stringContaining('plafond'));
  });

  it("insérer un billet appelle l'API avec un uuid v4 et met à jour le solde", async () => {
    const { user, mocks } = setup();
    await user.click(await bill('5 000 Ar'));
    await waitFor(() => expect(mocks.deposit).toHaveBeenCalledTimes(1));
    const arg = mocks.deposit.mock.calls[0]?.[0] as { bill: number; insertionId: string };
    expect(arg.bill).toBe(5_000);
    expect(arg.insertionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await screen.findByLabelText('Solde du wallet')).toHaveTextContent('5 000 Ar');
  });

  it("chaque billet a son propre identifiant d'insertion", async () => {
    const { user, mocks } = setup();
    await user.click(await bill('1 000 Ar'));
    await waitFor(() => expect(screen.getByLabelText('Solde du wallet')).toHaveTextContent('1 000 Ar'));
    await user.click(await bill('1 000 Ar'));
    await waitFor(() => expect(mocks.deposit).toHaveBeenCalledTimes(2));
    const ids = mocks.deposit.mock.calls.map((c) => (c[0] as { insertionId: string }).insertionId);
    expect(new Set(ids).size).toBe(2);
  });

  it('réponse perdue : bouton « Réessayer » qui réutilise le MÊME identifiant (pas de double crédit)', async () => {
    const { user, mocks } = setup();
    mocks.deposit.mockRejectedValueOnce(new NetworkError());
    await user.click(await bill('2 000 Ar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre la machine');
    await user.click(screen.getByRole('button', { name: nb("Réessayer l'insertion du billet de 2 000 Ar") }));
    await waitFor(() => expect(mocks.deposit).toHaveBeenCalledTimes(2));
    const [a, b] = mocks.deposit.mock.calls.map((c) => (c[0] as { insertionId: string }).insertionId);
    expect(a).toBe(b);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Réessayer/ })).not.toBeInTheDocument());
  });

  it('billet refusé par le serveur : message, pas de bouton de nouvel essai', async () => {
    const { user, mocks } = setup();
    mocks.deposit.mockRejectedValueOnce(new ApiError(422, 'BILL_REJECTED', 'x'));
    await user.click(await bill('1 000 Ar'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Billet refusé par le monnayeur');
    expect(screen.queryByRole('button', { name: /Réessayer/ })).not.toBeInTheDocument();
  });
});

describe('ClientScreen : validation', () => {
  it('commande réussie : appelle onFinished avec les noms et quantités servies', async () => {
    const { user, mocks, onFinished } = setup({ balance: 5_000 });
    await add(user, 'Cola', 2);
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    const r = onFinished.mock.calls[0]?.[0];
    expect(r.outcome).toMatchObject({ status: 'DISPENSED', totalAr: 3_000, balanceAr: 2_000 });
    expect(r.lines).toEqual([{ name: 'Cola', priceAr: 1_500, qty: 2, deliveredQty: 2 }]);
    const [items, key] = mocks.order.mock.calls[0] as [{ productId: string; qty: number }[], string];
    expect(items).toEqual([{ productId: 'p-cola', qty: 2 }]);
    expect(key.length).toBeGreaterThanOrEqual(8);
  });

  it('pendant la distribution : bouton occupé, tout est bloqué', async () => {
    const { user, mocks } = setup({ balance: 5_000 });
    let release: () => void = () => undefined;
    mocks.order.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () =>
            res({ orderId: 'o', status: 'DISPENSED', totalAr: 1_500, refundedAr: 0, balanceAr: 3_500, replayed: false, items: [] });
        }),
    );
    await add(user, 'Cola');
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('button', { name: 'Distribution en cours…' })).toBeDisabled();
    expect(screen.getByRole('status', { name: '' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ajouter une Cola/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: nb('Insérer un billet de 1 000 Ar') })).toBeDisabled();
    release();
  });

  it('stock épuisé entre-temps (422) : message, stock rechargé, panier ramené au stock', async () => {
    const { user, mocks, s } = setup({ balance: 9_000 });
    await add(user, 'Cola', 3);
    mocks.order.mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_STOCK', 'x', { lineIndex: 0 }));
    s.products = [{ ...COLA, stock: 1 }, EAU];
    const before = mocks.products.mock.calls.length;
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stock insuffisant');
    await waitFor(() => expect(mocks.products.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByLabelText('Quantité de Cola')).toHaveTextContent('1'));
  });

  it('solde insuffisant côté serveur : le montant manquant est affiché', async () => {
    const { user, mocks } = setup({ balance: 5_000 });
    await add(user, 'Cola');
    mocks.order.mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_FUNDS', 'x', { missingAr: 700 }));
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('il manque 700 Ar');
  });

  it("réponse perdue : même clé d'idempotence au nouvel essai, nouvelle clé si le panier change", async () => {
    const { user, mocks } = setup({ balance: 9_000 });
    await add(user, 'Cola');
    mocks.order.mockRejectedValueOnce(new NetworkError());
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre la machine');
    mocks.order.mockRejectedValueOnce(new NetworkError());
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));
    await waitFor(() => expect(mocks.order).toHaveBeenCalledTimes(2));
    await add(user, 'Eau'); // le panier change
    mocks.order.mockRejectedValueOnce(new NetworkError());
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));
    await waitFor(() => expect(mocks.order).toHaveBeenCalledTimes(3));
    const keys = mocks.order.mock.calls.map((c) => c[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe('ClientScreen : réponse perdue pendant la validation', () => {
  it("signale le résultat INCERTAIN et ne rafraîchit pas à l'aveugle ; un refus serveur, lui, rafraîchit", async () => {
    const { user, mocks, onOrderUncertain } = setup({ balance: 9_000 });
    await add(user, 'Cola');
    mocks.order.mockRejectedValueOnce(new NetworkError());
    const before = mocks.me.mock.calls.length + mocks.products.mock.calls.length + mocks.wallet.mock.calls.length;
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre la machine');
    expect(onOrderUncertain).toHaveBeenCalledTimes(1);
    expect(mocks.me.mock.calls.length + mocks.products.mock.calls.length + mocks.wallet.mock.calls.length).toBe(before);
    mocks.order.mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_STOCK', 'x'));
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));
    await waitFor(() =>
      expect(mocks.products.mock.calls.length).toBeGreaterThan(before - mocks.me.mock.calls.length - mocks.wallet.mock.calls.length),
    );
    expect(onOrderUncertain).toHaveBeenCalledTimes(1); // pas pour un refus serveur
  });
});

describe('ClientScreen : session', () => {
  it("déconnexion : appelle l'API puis onLoggedOut ; refusée pendant la distribution", async () => {
    const { user, mocks, onLoggedOut } = setup();
    mocks.logout.mockRejectedValueOnce(new ApiError(409, 'DISPENSING_IN_PROGRESS', 'x'));
    await user.click(await screen.findByRole('button', { name: 'Me déconnecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('distribution est en cours');
    expect(onLoggedOut).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Me déconnecter' }));
    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledTimes(1));
  });

  it('dernière commande consultable', async () => {
    const { user } = setup({
      last: { orderId: 'o', status: 'PARTIALLY_DISPENSED', totalAr: 4_500, refundedAr: 3_000, balanceAr: 0, replayed: true, items: [] },
    });
    await user.click(await screen.findByText('Ma dernière commande'));
    expect(await screen.findByText(/Partiellement servie — 4 500 Ar, remboursé 3 000 Ar/)).toBeInTheDocument();
  });
});

describe('SessionCountdown', () => {
  afterEach(() => vi.useRealTimers());

  it('affiche le temps restant mesuré par le serveur et décroît', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    render2(120_000, 1_000_000);
    expect(screen.getByRole('timer')).toHaveTextContent('2:00');
    act(() => void vi.advanceTimersByTime(45_000));
    expect(screen.getByRole('timer')).toHaveTextContent('1:15');
  });

  it("alerte à moins de 30 s (annonce lecteur d'écran) et appelle onExpire UNE fois à 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const onExpire = vi.fn();
    render2(40_000, 1_000_000, onExpire);
    expect(screen.queryByText(/expire dans moins de 30 secondes/)).not.toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(11_000));
    expect(screen.getByText(/expire dans moins de 30 secondes/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(40_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('sans expiration (distribution) : message dédié', () => {
    render2(null, Date.now());
    expect(screen.getByText('Distribution en cours…')).toBeInTheDocument();
  });

  it('une nouvelle mesure serveur remet le compteur à jour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { rerender } = render2(30_000, 1_000_000);
    act(() => void vi.advanceTimersByTime(20_000));
    rerender(<SessionCountdown remainingMs={120_000} syncedAt={1_020_000} onExpire={() => undefined} />);
    expect(screen.getByRole('timer')).toHaveTextContent('2:00');
  });
});

import { render } from '@testing-library/react';
function render2(remainingMs: number | null, syncedAt: number, onExpire: () => void = () => undefined) {
  return render(<SessionCountdown remainingMs={remainingMs} syncedAt={syncedAt} onExpire={onExpire} />);
}

describe('ResultScreen', () => {
  const lines = [{ name: 'Cola', priceAr: 1_500, qty: 3, deliveredQty: 1 }];
  const outcome = (status: 'DISPENSED' | 'PARTIALLY_DISPENSED' | 'FAILED', refundedAr: number) =>
    ({ orderId: 'o', status, totalAr: 4_500, refundedAr, balanceAr: 8_500, replayed: false, items: [] }) as const;

  it('succès : titre, aucune mention de remboursement', () => {
    renderWithApi(
      <ResultScreen result={{ outcome: outcome('DISPENSED', 0), lines: [{ ...lines[0]!, deliveredQty: 3 }] }} onDone={() => undefined} />,
      createFakeApi().api,
    );
    expect(screen.getByRole('heading', { name: 'Commande servie' })).toBeInTheDocument();
    expect(screen.getByText('3 boisson(s) servie(s) sur 3.')).toBeInTheDocument();
    expect(screen.queryByText(/remboursés/)).not.toBeInTheDocument();
  });
  it('partiel : unités non servies et montant remboursé en évidence', () => {
    renderWithApi(
      <ResultScreen result={{ outcome: outcome('PARTIALLY_DISPENSED', 3_000), lines }} onDone={() => undefined} />,
      createFakeApi().api,
    );
    expect(screen.getByRole('heading', { name: 'Commande partiellement servie' })).toBeInTheDocument();
    expect(screen.getByText('3 000 Ar ont été remboursés dans votre wallet.')).toBeInTheDocument();
    expect(screen.getByText('1 / 3 non servie(s)')).toBeInTheDocument();
    expect(screen.getByText('8 500 Ar')).toBeInTheDocument();
  });
  it('échec total : remboursement total', () => {
    renderWithApi(
      <ResultScreen result={{ outcome: outcome('FAILED', 4_500), lines: [{ ...lines[0]!, deliveredQty: 0 }] }} onDone={() => undefined} />,
      createFakeApi().api,
    );
    expect(screen.getByRole('heading', { name: 'Distribution impossible' })).toBeInTheDocument();
    expect(screen.getByText('0 boisson(s) servie(s) sur 3.')).toBeInTheDocument();
  });
  it("le titre reçoit le focus (lecteur d'écran) et « Terminer » appelle onDone", async () => {
    const onDone = vi.fn();
    renderWithApi(<ResultScreen result={{ outcome: outcome('DISPENSED', 0), lines }} onDone={onDone} />, createFakeApi().api);
    expect(screen.getByRole('heading', { name: 'Commande servie' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Terminer' }));
    expect(onDone).toHaveBeenCalled();
    expect(within(document.body).getByText(/Votre session est terminée/)).toBeInTheDocument();
  });
});
