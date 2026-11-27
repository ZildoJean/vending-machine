import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { ADMIN_ME, CLIENT_ME, COLA, createFakeApi } from './test/fake-api';
import { renderWithApi } from './test/render';
import { AdminScreen } from './screens/AdminScreen';
import { ClientScreen } from './screens/ClientScreen';
import { LoginScreen } from './screens/LoginScreen';
import { ResultScreen } from './screens/ResultScreen';
import { App } from './App';

/**
 * Règles WCAG 2.x A/AA évaluables sans mise en page (jsdom ne calcule pas les couleurs : le CONTRASTE
 * n'est donc pas vérifié ici, et reste à contrôler dans un vrai navigateur).
 */
async function violations(container: HTMLElement): Promise<string[]> {
  const res = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return res.violations.map((v) => `${v.id} : ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`);
}

const lines = [{ name: 'Cola', priceAr: 1_500, qty: 3, deliveredQty: 1 }];

describe('accessibilité (axe-core, WCAG A/AA hors contraste)', () => {
  it('connexion', async () => {
    const { container } = renderWithApi(<LoginScreen notice="Votre session a expiré." onLoggedIn={() => undefined} />, createFakeApi().api);
    await screen.findByRole('heading', { name: 'Connexion' });
    expect(await violations(container)).toEqual([]);
  });

  it('connexion avec une erreur affichée', async () => {
    const f = createFakeApi();
    f.mocks.login.mockRejectedValueOnce(new Error('x'));
    const user = userEvent.setup();
    const { container } = renderWithApi(<LoginScreen notice={null} onLoggedIn={() => undefined} />, f.api);
    await user.type(screen.getByLabelText('Identifiant'), 'a');
    await user.type(screen.getByLabelText(/PIN/), 'b');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('machine du client (panier rempli, erreur affichée, dernière commande ouverte)', async () => {
    const f = createFakeApi({
      balance: 1_000,
      products: [COLA, { id: 'p-vide', name: 'Jus', priceAr: 700, stock: 0 }],
      last: { orderId: 'o', status: 'DISPENSED', totalAr: 1_500, refundedAr: 0, balanceAr: 0, replayed: true, items: [] },
    });
    const user = userEvent.setup();
    const { container } = renderWithApi(
      <ClientScreen
        me={CLIENT_ME}
        syncedAt={Date.now()}
        onFinished={() => undefined}
        onLoggedOut={() => undefined}
        onOrderUncertain={() => undefined}
      />,
      f.api,
    );
    await user.click(await screen.findByRole('button', { name: /Ajouter une Cola/ }));
    await user.click(screen.getByText('Ma dernière commande'));
    await screen.findByText(/Servie — /);
    expect(await violations(container)).toEqual([]);
  });

  it.each([
    ['DISPENSED', 0],
    ['PARTIALLY_DISPENSED', 3_000],
    ['FAILED', 4_500],
  ] as const)('résultat %s', async (status, refundedAr) => {
    const { container } = renderWithApi(
      <ResultScreen
        result={{ outcome: { orderId: 'o', status, totalAr: 4_500, refundedAr, balanceAr: 1_000, replayed: false, items: [] }, lines }}
        onDone={() => undefined}
      />,
      createFakeApi().api,
    );
    expect(await violations(container)).toEqual([]);
  });

  it.each([['Machine'], ['Produits'], ['Comptes'], ['Audit']])('administration : onglet %s', async (name) => {
    const f = createFakeApi({
      adminMachine: { status: 'MAINTENANCE', ownedByMe: true, remainingMs: 600_000 },
      adminProducts: [
        { id: 'p1', name: 'Cola', priceAr: 1_500, stock: 4, active: true },
        { id: 'p2', name: 'Eau', priceAr: 500, stock: 0, active: false },
      ],
      users: [
        { id: 'c1', login: 'dave', locked: true },
        { id: 'c2', login: 'erin', locked: false },
      ],
      audit: [
        {
          id: 1,
          actorId: 'a1',
          action: 'PRODUCT_UPDATE',
          entity: 'product',
          entityId: 'p1',
          oldValue: { priceAr: 1 },
          newValue: { priceAr: 2 },
          createdAt: 1_700_000_000_000,
        },
      ],
    });
    const user = userEvent.setup();
    const { container } = renderWithApi(<AdminScreen me={ADMIN_ME} onLoggedOut={() => undefined} />, f.api);
    await user.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(container.querySelector('h2')).not.toBeNull());
    if (name === 'Produits') await screen.findByLabelText('Nom (Cola)');
    if (name === 'Comptes') await screen.findByText('dave');
    if (name === 'Audit') await screen.findByText("Modification d'un produit");
    expect(await violations(container)).toEqual([]);
  });

  it("application complète : titre, lien d'évitement, un seul h1 et repères", async () => {
    const f = createFakeApi({ me: null });
    const { container } = render(<App makeApi={() => f.api} />);
    await screen.findByRole('heading', { name: 'Connexion' });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('main#contenu')).not.toBeNull();
    expect(await violations(container)).toEqual([]);
  });
});
