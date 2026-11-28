import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ApiError, NetworkError } from '../api/client';
import { ADMIN_ME, CLIENT_ME, createFakeApi } from '../test/fake-api';
import { renderWithApi } from '../test/render';
import { LoginScreen } from './LoginScreen';

const fill = async (user: ReturnType<typeof userEvent.setup>, login: string, secret: string) => {
  await user.type(screen.getByLabelText('Identifiant'), login);
  await user.type(screen.getByLabelText(/PIN \(6 chiffres\)/), secret);
};

describe('LoginScreen', () => {
  it("affiche l'état public de la machine", async () => {
    const f = createFakeApi();
    f.mocks.machineStatus.mockResolvedValue({ status: 'MAINTENANCE' as never });
    renderWithApi(<LoginScreen notice={null} onLoggedIn={() => undefined} />, f.api);
    expect(await screen.findByText('Machine en maintenance')).toBeInTheDocument();
  });

  it('bouton désactivé tant que les champs sont vides', async () => {
    renderWithApi(<LoginScreen notice={null} onLoggedIn={() => undefined} />, createFakeApi().api);
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeDisabled();
  });

  it('connexion : identifiant nettoyé, secret transmis, onLoggedIn appelé', async () => {
    const f = createFakeApi();
    const onLoggedIn = vi.fn();
    const user = userEvent.setup();
    renderWithApi(<LoginScreen notice={null} onLoggedIn={onLoggedIn} />, f.api);
    await fill(user, '  alice  ', '135792');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledTimes(1));
    expect(f.mocks.login).toHaveBeenCalledWith('alice', '135792');
  });

  it('le champ secret est masqué et ne conserve rien après une connexion réussie', async () => {
    const f = createFakeApi();
    const user = userEvent.setup();
    renderWithApi(<LoginScreen notice={null} onLoggedIn={() => undefined} />, f.api);
    expect(screen.getByLabelText(/PIN \(6 chiffres\)/)).toHaveAttribute('type', 'password');
    await fill(user, 'alice', '135792');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await waitFor(() => expect(screen.getByLabelText(/PIN \(6 chiffres\)/)).toHaveValue(''));
  });

  it.each([
    ['INVALID_CREDENTIALS', 401, 'Identifiants invalides, ou compte temporairement verrouillé.'],
    ['MACHINE_BUSY', 409, 'La machine est utilisée par un autre client'],
    ['OUT_OF_SERVICE', 503, 'La machine est en maintenance'],
    ['RATE_LIMITED', 429, 'Trop de tentatives'],
  ] as const)('erreur %s : message clair en français', async (code, status, text) => {
    const f = createFakeApi();
    f.mocks.login.mockRejectedValueOnce(new ApiError(status, code, 'x'));
    const user = userEvent.setup();
    renderWithApi(<LoginScreen notice={null} onLoggedIn={() => undefined} />, f.api);
    await fill(user, 'alice', '135792');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('une erreur de connexion ne révèle jamais si le compte existe (même message pour tous les 401)', async () => {
    const f = createFakeApi();
    f.mocks.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'x'));
    const user = userEvent.setup();
    renderWithApi(<LoginScreen notice={null} onLoggedIn={() => undefined} />, f.api);
    await fill(user, 'inconnu', '000000');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    const a = (await screen.findByRole('alert')).textContent;
    expect(a).not.toMatch(/inconnu|n'existe pas|introuvable/i);
  });

  it("notice d'expiration affichée", () => {
    renderWithApi(<LoginScreen notice="Votre session a expiré par inactivité." onLoggedIn={() => undefined} />, createFakeApi().api);
    expect(screen.getByText('Votre session a expiré par inactivité.')).toBeInTheDocument();
  });
});

const mount = (fake: ReturnType<typeof createFakeApi>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let unauthorized: (c: string) => void = () => undefined;
  const makeApi = (cb: (c: string) => void) => {
    unauthorized = cb;
    return fake.api;
  };
  const utils = render(<App makeApi={makeApi} queryClient={qc} />);
  return { ...utils, qc, unauthorized: (c: string) => unauthorized(c) };
};

describe('App : routage selon la session', () => {
  it('non connecté -> écran de connexion', async () => {
    mount(createFakeApi({ me: null }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
  });
  it('client -> machine ; administrateur -> administration', async () => {
    const c = mount(createFakeApi({ me: CLIENT_ME }));
    expect(await screen.findByText('Boissons')).toBeInTheDocument();
    c.unmount();
    mount(createFakeApi({ me: ADMIN_ME }));
    expect(await screen.findByText(/Administrateur :/)).toBeInTheDocument();
  });
  it("titre principal et lien d'évitement présents (accessibilité)", async () => {
    mount(createFakeApi({ me: null }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Distributeur de boissons' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Aller au contenu' })).toHaveAttribute('href', '#contenu');
  });

  it("session expirée pendant une action : retour à la connexion AVEC l'explication", async () => {
    const f = createFakeApi({ balance: 1_000 });
    const m = mount(f);
    const user = userEvent.setup();
    await screen.findByText('Boissons');
    f.mocks.deposit.mockImplementationOnce(async () => {
      f.s.me = null;
      m.unauthorized('SESSION_EXPIRED');
      throw new ApiError(401, 'SESSION_EXPIRED', 'x');
    });
    await user.click(await screen.findByRole('button', { name: /Insérer un billet de 1\s000\sAr/ }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.getByText('Votre session a expiré par inactivité. Reconnectez-vous.')).toBeInTheDocument();
  });

  it('session fermée après une validation SANS réponse : message honnête (pas « expirée par inactivité »)', async () => {
    const f = createFakeApi({ balance: 5_000 });
    const m = mount(f);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Ajouter une Cola/ }));
    f.mocks.order.mockRejectedValueOnce(new NetworkError());
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre la machine');
    f.s.me = null;
    m.unauthorized('SESSION_EXPIRED'); // le serveur répond 401 au prochain appel
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.getByText(/elle a peut-être été traitée/)).toBeInTheDocument();
    expect(screen.queryByText(/expiré par inactivité/)).not.toBeInTheDocument();
  });

  it('commande terminée : résultat affiché (même si la session est déjà fermée), puis « Terminer » -> connexion', async () => {
    const f = createFakeApi({ balance: 5_000 });
    f.mocks.order.mockImplementationOnce(async (items: { productId: string; qty: number }[]) => {
      f.s.me = null; // le serveur ferme la session après la commande
      return {
        orderId: 'o',
        status: 'DISPENSED' as const,
        totalAr: 1_500,
        refundedAr: 0,
        balanceAr: 3_500,
        replayed: false,
        items: items.map((i) => ({ ...i, deliveredQty: i.qty })),
      };
    });
    mount(f);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Ajouter une Cola/ }));
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('heading', { name: 'Commande servie' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Terminer' }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.queryByText('Votre session a expiré par inactivité. Reconnectez-vous.')).not.toBeInTheDocument();
  });

  it("isolation : les données d'un client ne sont jamais visibles par le suivant", async () => {
    const f = createFakeApi({ balance: 7_000 });
    const m = mount(f);
    const user = userEvent.setup();
    await screen.findByText('Boissons');
    expect(await screen.findByLabelText('Solde du wallet')).toHaveTextContent('7 000 Ar');
    await user.click(screen.getByRole('button', { name: 'Me déconnecter' }));
    await screen.findByRole('heading', { name: 'Connexion' });
    expect(m.qc.getQueryCache().findAll({ queryKey: ['wallet'] })).toHaveLength(0);
    expect(m.qc.getQueryCache().findAll({ queryKey: ['products'] })).toHaveLength(0);
    // un autre client se connecte : il doit voir SON solde, pas celui du précédent
    f.s.me = { ...CLIENT_ME, userId: 'u2', login: 'bob' };
    f.s.balance = 100;
    await user.type(screen.getByLabelText('Identifiant'), 'bob');
    await user.type(screen.getByLabelText(/PIN \(6 chiffres\)/), '246813');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByLabelText('Solde du wallet')).toHaveTextContent('100 Ar');
  });
});
